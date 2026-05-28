import { describe, expect, it } from "vitest";
import { createAgentRuntime, shell } from "@flamecast/agentjsx";
import type { Shell } from "@flamecast/agentjsx";
import { scriptedInfer, toolCall } from "../helpers/scripted-infer";

const mountShell = (
  opts: Parameters<typeof shell>[1],
): { agent: ReturnType<typeof createAgentRuntime>; timeouts: number[]; cmds: string[] } => {
  const timeouts: number[] = [];
  const cmds: string[] = [];
  const sh: Shell = {
    async exec(cmd, execOpts) {
      cmds.push(cmd);
      timeouts.push(execOpts?.timeout ?? -1);
      return { stdout: "out", stderr: "", exitCode: 0 };
    },
  };
  // One tool call per driver; scriptedInfer returns one per send.
  const agent = createAgentRuntime({
    infer: scriptedInfer([
      { content: "", tool_calls: [toolCall("c1", "bash", { cmd: "a", timeout: 2_147_483_647 })] },
      { content: "ok" },
    ]),
    extensions: [shell(sh, opts)],
  });
  return { agent, timeouts, cmds };
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

describe("agentctx: shell extension", () => {
  it("clamps LLM-supplied timeout above maxTimeout down to maxTimeout", async () => {
    const { agent, timeouts } = mountShell({ maxTimeout: 900_000 });
    try {
      agent.run("go");
      await waitForAssistant(agent);
      expect(timeouts).toEqual([900_000]);
    } finally {
      await agent.dispose();
    }
  });

  it("falls back to defaultTimeout for non-finite, zero, or negative inputs", async () => {
    const timeouts: number[] = [];
    const sh: Shell = {
      async exec(_cmd, execOpts) {
        timeouts.push(execOpts?.timeout ?? -1);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const agent = createAgentRuntime({
      infer: scriptedInfer([
        { content: "", tool_calls: [toolCall("c1", "bash", { cmd: "a", timeout: Number.NaN })] },
        { content: "", tool_calls: [toolCall("c2", "bash", { cmd: "b", timeout: -5 })] },
        { content: "", tool_calls: [toolCall("c3", "bash", { cmd: "c", timeout: 0 })] },
        {
          content: "",
          tool_calls: [
            toolCall("c4", "bash", {
              cmd: "d",
              timeout: Number.POSITIVE_INFINITY,
            }),
          ],
        },
        { content: "done" },
      ]),
      extensions: [shell(sh, { defaultTimeout: 60_000, maxTimeout: 900_000 })],
    });
    try {
      agent.run("go");
      await agent.until((s) => {
        const count = s.events.filter((e) => e.type === "assistant.message").length;
        return count >= 5 ? true : null;
      });
      expect(timeouts).toEqual([60_000, 60_000, 60_000, 60_000]);
    } finally {
      await agent.dispose();
    }
  });

  it("passes reasonable LLM-supplied timeouts through unchanged", async () => {
    const timeouts: number[] = [];
    const sh: Shell = {
      async exec(_cmd, execOpts) {
        timeouts.push(execOpts?.timeout ?? -1);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const agent = createAgentRuntime({
      infer: scriptedInfer([
        { content: "", tool_calls: [toolCall("c1", "bash", { cmd: "x", timeout: 5_000 })] },
        { content: "done" },
      ]),
      extensions: [shell(sh, { defaultTimeout: 60_000, maxTimeout: 900_000 })],
    });
    try {
      agent.run("go");
      await waitForAssistant(agent);
      expect(timeouts).toEqual([5_000]);
    } finally {
      await agent.dispose();
    }
  });

  it("cd tool mutates persistent cwd used by subsequent bash calls", async () => {
    const cwds: Array<string | undefined> = [];
    const sh: Shell = {
      async exec(_cmd, execOpts) {
        cwds.push(execOpts?.cwd);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const agent = createAgentRuntime({
      infer: scriptedInfer([
        { content: "", tool_calls: [toolCall("c1", "bash", { cmd: "first" })] },
        { content: "", tool_calls: [toolCall("c2", "cd", { path: "/tmp" })] },
        { content: "", tool_calls: [toolCall("c3", "bash", { cmd: "second" })] },
        { content: "done" },
      ]),
      extensions: [shell(sh, { cwd: "/start" })],
    });
    try {
      agent.run("go");
      await agent.until((s) => {
        const count = s.events.filter((e) => e.type === "assistant.message").length;
        return count >= 4 ? true : null;
      });
      expect(cwds).toEqual(["/start", "/tmp"]);
    } finally {
      await agent.dispose();
    }
  });
});
