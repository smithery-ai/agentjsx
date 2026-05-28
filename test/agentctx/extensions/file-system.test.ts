import { describe, expect, it } from "vitest";
import {
  createAgentRuntime,
  createInMemoryStore,
  fileSystem,
} from "@flamecast/agentjsx";
import type { FileInfo, FileStore } from "@flamecast/agentjsx";
import { scriptedInfer, toolCall } from "../helpers/scripted-infer";

const stubStore = (
  paths: Array<{ path: string; size?: number; type?: "file" | "dir" }>,
): FileStore => {
  const files: FileInfo[] = paths.map((p) => ({
    path: p.path,
    size: p.size ?? 0,
    type: p.type ?? "file",
  }));
  return {
    async read() {
      return null;
    },
    async write() {},
    async list() {
      return files;
    },
    async delete() {},
    async glob() {
      return files;
    },
    async stat() {
      return null;
    },
  };
};

const waitForAssistant = async (
  agent: ReturnType<typeof createAgentRuntime>,
): Promise<void> => {
  await agent.until((s) => {
    const last = s.events.at(-1);
    return last?.type === "assistant.message" &&
      (!last.tool_calls || last.tool_calls.length === 0)
      ? true
      : null;
  });
};

describe("agentctx: fileSystem extension", () => {
  it("dispatches read_file to the backend", async () => {
    const store = createInMemoryStore({ initial: { "hello.txt": "banana pancakes" } });
    const agent = createAgentRuntime({
      infer: scriptedInfer([
        { content: "", tool_calls: [toolCall("c1", "read_file", { path: "hello.txt" })] },
        { content: "ok" },
      ]),
      extensions: [fileSystem(store)],
    });
    try {
      agent.run("go");
      await waitForAssistant(agent);
      const result = (await agent.events()).find(
        (e) => e.type === "tool.result" && e.tool_call_id === "c1",
      );
      expect(result && "content" in result ? result.content : "").toBe("banana pancakes");
    } finally {
      await agent.dispose();
    }
  });

  it("write_file persists and reports success", async () => {
    const store = createInMemoryStore();
    const agent = createAgentRuntime({
      infer: scriptedInfer([
        {
          content: "",
          tool_calls: [toolCall("c1", "write_file", { path: "note.md", content: "hi" })],
        },
        { content: "ok" },
      ]),
      extensions: [fileSystem(store)],
    });
    try {
      agent.run("go");
      await waitForAssistant(agent);
      expect(await store.read("note.md")).toBe("hi");
      const result = (await agent.events()).find(
        (e) => e.type === "tool.result" && e.tool_call_id === "c1",
      );
      expect(result && "content" in result ? result.content : "").toMatch(/Wrote note.md/);
    } finally {
      await agent.dispose();
    }
  });

  it("read_file of a missing path returns a not-found string", async () => {
    const agent = createAgentRuntime({
      infer: scriptedInfer([
        { content: "", tool_calls: [toolCall("c1", "read_file", { path: "ghost.txt" })] },
        { content: "ok" },
      ]),
      extensions: [fileSystem(createInMemoryStore())],
    });
    try {
      agent.run("go");
      await waitForAssistant(agent);
      const result = (await agent.events()).find(
        (e) => e.type === "tool.result" && e.tool_call_id === "c1",
      );
      expect(result && "content" in result ? result.content : "").toMatch(
        /File not found: ghost.txt/,
      );
    } finally {
      await agent.dispose();
    }
  });

  it("delete_file removes the entry and reports success", async () => {
    const store = createInMemoryStore({ initial: { "a.txt": "x" } });
    const agent = createAgentRuntime({
      infer: scriptedInfer([
        { content: "", tool_calls: [toolCall("c1", "delete_file", { path: "a.txt" })] },
        { content: "ok" },
      ]),
      extensions: [fileSystem(store)],
    });
    try {
      agent.run("go");
      await waitForAssistant(agent);
      expect(await store.read("a.txt")).toBeNull();
      const result = (await agent.events()).find(
        (e) => e.type === "tool.result" && e.tool_call_id === "c1",
      );
      expect(result && "content" in result ? result.content : "").toMatch(/Deleted a.txt/);
    } finally {
      await agent.dispose();
    }
  });

  it("glob_files forwards pattern and returns matches as JSON", async () => {
    const store = createInMemoryStore({
      initial: { "src/a.ts": "", "src/b.ts": "", "docs/c.md": "" },
    });
    const agent = createAgentRuntime({
      infer: scriptedInfer([
        { content: "", tool_calls: [toolCall("c1", "glob_files", { pattern: "src/*.ts" })] },
        { content: "ok" },
      ]),
      extensions: [fileSystem(store)],
    });
    try {
      agent.run("go");
      await waitForAssistant(agent);
      const result = (await agent.events()).find(
        (e) => e.type === "tool.result" && e.tool_call_id === "c1",
      );
      const payload = result?.type === "tool.result" ? result.content : "[]";
      const parsed: FileInfo[] = JSON.parse(payload);
      expect(parsed.map((p) => p.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    } finally {
      await agent.dispose();
    }
  });

  it("renders a bounded ASCII tree in the workspace block", async () => {
    const store = stubStore([
      { path: "README.md" },
      { path: "src/foo.ts" },
      { path: "src/bar.ts" },
      { path: "src/sub/deep.ts" },
      { path: "node_modules/junk.ts" },
    ]);
    const agent = createAgentRuntime({
      infer: scriptedInfer([{ content: "ok" }]),
      extensions: [fileSystem(store)],
    });
    try {
      agent.run("trigger");
      await waitForAssistant(agent);
      // The workspace ambient materializes into the system prefix.
      const sys = await agent.until((s) => {
        const text = typeof s.rendered.system === "string"
          ? s.rendered.system
          : s.rendered.system.map((c) => c.text).join("\n\n");
        return /## Workspace \(tree/.test(text) ? text : null;
      });
      expect(sys).toContain("src/");
      expect(sys).toContain("foo.ts");
      expect(sys).not.toContain("node_modules");
    } finally {
      await agent.dispose();
    }
  });

  it("caps the tree at maxTreeFiles with a truncation marker", async () => {
    const paths = Array.from({ length: 200 }, (_, i) => ({ path: `src/f${i}.ts` }));
    const agent = createAgentRuntime({
      infer: scriptedInfer([{ content: "ok" }]),
      extensions: [fileSystem(stubStore(paths), { maxTreeFiles: 10 })],
    });
    try {
      agent.run("trigger");
      await waitForAssistant(agent);
      const sys = await agent.until((s) => {
        const text = typeof s.rendered.system === "string"
          ? s.rendered.system
          : s.rendered.system.map((c) => c.text).join("\n\n");
        return /more entries truncated/.test(text) ? text : null;
      });
      expect(sys).toMatch(/more entries truncated/);
    } finally {
      await agent.dispose();
    }
  });
});
