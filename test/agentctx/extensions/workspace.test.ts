import { describe, expect, it } from "vitest";
import {
  createAgentRuntime,
  createInMemoryStore,
  workspace,
  type Shell,
  type Workspace,
} from "@flamecast/agentjsx";
import { scriptedInfer, toolCall } from "../helpers/scripted-infer";

const makeWorkspace = (root: string, execOpts: { cwd: string[] }): Workspace => {
  const sh: Shell = {
    async exec(_cmd, opts) {
      execOpts.cwd.push(opts?.cwd ?? "<none>");
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
  };
  const fs = createInMemoryStore({ initial: { "src/a.ts": "export const a = 1;" } });
  return { root, shell: sh, fs };
};

describe("agentctx: workspace extension", () => {
  it("wires shell's initial cwd to the workspace root so bash() and read_file() agree", async () => {
    const execOpts = { cwd: [] as string[] };
    const ws = makeWorkspace("/home/agent/repo", execOpts);

    const agent = createAgentRuntime({
      infer: scriptedInfer([
        {
          content: "",
          tool_calls: [
            toolCall("b1", "bash", { cmd: "pwd" }),
            toolCall("r1", "read_file", { path: "src/a.ts" }),
          ],
        },
        { content: "done" },
      ]),
      extensions: [workspace(ws)],
    });

    try {
      agent.run("go");
      await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" && last.content === "done"
          ? last
          : null;
      });

      expect(execOpts.cwd).toEqual(["/home/agent/repo"]);

      const events = await agent.events();
      const readResult = events.find(
        (e) => e.type === "tool.result" && e.tool_call_id === "r1",
      );
      expect(
        readResult && readResult.type === "tool.result" && readResult.content,
      ).toBe("export const a = 1;");
    } finally {
      await agent.dispose();
    }
  });

  it("registers all tools from both underlying extensions", async () => {
    const execOpts = { cwd: [] as string[] };
    const ws = makeWorkspace("/w", execOpts);

    let toolNames: string[] | null = null;
    const agent = createAgentRuntime({
      infer: async (context) => {
        toolNames = context.tools.map((t) => t.name).sort();
        return { content: "done" };
      },
      extensions: [workspace(ws)],
    });

    try {
      agent.run("inspect");
      await agent.until((s) =>
        s.events.some((e) => e.type === "assistant.message") ? true : null,
      );
      expect(toolNames).toEqual(
        [
          "bash",
          "cd",
          "delete_file",
          "glob_files",
          "list_files",
          "read_file",
          "stat_file",
          "write_file",
        ].sort(),
      );
    } finally {
      await agent.dispose();
    }
  });
});
