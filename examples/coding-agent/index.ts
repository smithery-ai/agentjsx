// A minimal local coding agent built on effectctx.
//
// Composes:
//   localWorkspace → host-process shell + real-disk fs rooted at one
//                    directory. Gives the model `bash`, `read_file`,
//                    `write_file`, `grep`, etc. plus a live tree ambient.
//   maxSteps       → safety stop so a runaway loop can't burn through
//                    your wallet.
//
// `localWorkspace` lives in `effectctx/node`. The Node-specific imports
// (node:fs/promises, node:child_process) live there, not in the core
// `effectctx` package, so the same runtime can also run in Cloudflare
// Workers or other non-Node environments with different adapters. See
// `examples/cloudflare-sandbox/` for the same agent on Workers.
//
// Run:
//   AI_GATEWAY_API_KEY=... npx tsx index.ts "find every TODO and group by file"

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { createAgentRuntime, createAiGatewayInfer } from "@flamecast/agentjsx";
import { maxSteps } from "@flamecast/agentjsx/extensions";
import { localWorkspace } from "@flamecast/agentjsx/node";

async function main() {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    console.error("Set AI_GATEWAY_API_KEY to a Vercel AI Gateway key.");
    process.exit(1);
  }
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    console.error('Usage: npx tsx index.ts "your prompt"');
    process.exit(1);
  }

  const root = resolve(process.cwd(), ".agent-workspace");
  await mkdir(root, { recursive: true });

  const agent = createAgentRuntime({
    system:
      "You are a coding assistant working inside the directory rooted at ./. " +
      "Use `bash`, `read_file`, `write_file`, and `list_dir` to explore and " +
      "modify code. Be concise and finish promptly.",
    infer: createAiGatewayInfer({
      apiKey,
      model: "anthropic/claude-sonnet-4-6",
    }),
    extensions: [
      localWorkspace({ root }),
      maxSteps(20),
    ],
  });

  await agent.send(prompt);
  const reply = await agent.until((snap) => {
    const last = snap.events.at(-1);
    if (last?.type === "assistant.halted") return { halted: last.reason };
    if (last?.type === "assistant.message" && last.content.length > 0) {
      return { text: last.content };
    }
    return null;
  });

  if ("halted" in reply) {
    console.error(`Agent halted: ${reply.halted}`);
  } else {
    console.log(reply.text);
  }

  await agent.dispose();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
