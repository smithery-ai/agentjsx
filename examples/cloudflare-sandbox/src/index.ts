// effectctx running inside a Cloudflare Worker, with the agent's shell and
// file system backed by a Cloudflare Sandbox. The Sandbox is a persistent,
// isolated Linux environment that survives across requests, so files the
// model writes in turn N are still there in turn N+1, even though the
// effectctx runtime itself is rebuilt per request.
//
// Cloudflare Sandboxes went GA in April 2026:
//   https://blog.cloudflare.com/sandbox-ga/

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { createAgentRuntime, createAiGatewayInfer } from "effectctx";
import {
  maxSteps,
  workspace,
  type FileInfo,
  type FileStore,
  type Shell,
} from "effectctx/extensions";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
  AI_GATEWAY_API_KEY: string;
};

// ---- Adapters ---------------------------------------------------------------
// Map Cloudflare Sandbox calls onto effectctx's Shell + FileStore interfaces.
// Same dependency-inversion pattern as the local example, just pointed at a
// different backend.

function sandboxAdapters(sandbox: ReturnType<typeof getSandbox>): {
  shell: Shell;
  fs: FileStore;
} {
  const shell: Shell = {
    exec: async (cmd, opts) => {
      const wrapped = opts?.cwd
        ? `cd ${JSON.stringify(opts.cwd)} && ${cmd}`
        : cmd;
      const result = await sandbox.exec(wrapped);
      return {
        stdout: result.stdout ?? "",
        stderr: (result as { stderr?: string }).stderr ?? "",
        exitCode:
          (result as { exitCode?: number }).exitCode ??
          (result.success ? 0 : 1),
      };
    },
  };

  const fs: FileStore = {
    read: async (path) => {
      try {
        const file = await sandbox.readFile(path);
        return file.content ?? null;
      } catch {
        return null;
      }
    },
    write: async (path, content) => {
      await sandbox.writeFile(path, content);
    },
    list: async (dir = "/workspace") => {
      // The SDK's structured listFiles has been moving target. Falling back
      // to a parsed `ls` keeps the example resilient to surface changes;
      // swap to sandbox.listFiles(...) when you've pinned a version.
      const result = await sandbox.exec(`ls -1ap ${JSON.stringify(dir)}`);
      const out: FileInfo[] = [];
      for (const raw of (result.stdout ?? "").split("\n")) {
        const name = raw.trim();
        if (!name || name === "./" || name === "../") continue;
        const isDir = name.endsWith("/");
        out.push({
          path: name.replace(/\/$/, ""),
          size: 0,
          type: isDir ? "dir" : "file",
        });
      }
      return out;
    },
    delete: async (path, opts) => {
      await sandbox.exec(
        `rm ${opts?.recursive ? "-rf" : "-f"} ${JSON.stringify(path)}`,
      );
    },
    glob: async () => [],
    stat: async (path) => {
      const result = await sandbox.exec(
        `stat -c '%s %F' ${JSON.stringify(path)} 2>/dev/null || true`,
      );
      const line = (result.stdout ?? "").trim();
      if (!line) return null;
      const [sizeStr, ...rest] = line.split(" ");
      const kind = rest.join(" ");
      return {
        path,
        size: Number.parseInt(sizeStr, 10) || 0,
        type: kind.includes("directory") ? "dir" : "file",
      };
    },
  };

  return { shell, fs };
}

// ---- Worker entry point -----------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/chat") {
      return new Response(
        'POST /chat with JSON: { "message": "...", "sandbox": "default" }',
        { status: 404 },
      );
    }

    const body = await request.json<{ message?: string; sandbox?: string }>();
    if (!body.message) {
      return new Response('missing "message" field', { status: 400 });
    }

    const sandboxName = body.sandbox ?? "default";
    const sandbox = getSandbox(env.Sandbox, sandboxName);
    const { shell, fs } = sandboxAdapters(sandbox);

    const agent = createAgentRuntime({
      system:
        "You are a coding assistant operating inside a Cloudflare Sandbox " +
        "rooted at /workspace. Use bash, read_file, write_file, and " +
        "list_dir to inspect and modify code. Be concise.",
      infer: createAiGatewayInfer({
        apiKey: env.AI_GATEWAY_API_KEY,
        model: "anthropic/claude-sonnet-4-6",
      }),
      extensions: [
        workspace({ root: "/workspace", shell, fs }),
        maxSteps(20),
      ],
    });

    try {
      await agent.send(body.message);
      const reply = await agent.until((snap) => {
        const last = snap.events.at(-1);
        if (last?.type === "assistant.halted") return { halted: last.reason };
        if (last?.type === "assistant.message" && last.content.length > 0) {
          return { text: last.content };
        }
        return null;
      });
      return Response.json(reply);
    } finally {
      await agent.dispose();
    }
  },
};
