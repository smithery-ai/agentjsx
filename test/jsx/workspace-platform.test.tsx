// End-to-end test for the JSX-component API driving createAgentRuntime
// WITH a real platform layer wired in. Mirrors `end-to-end.test.tsx`
// but provides `NodeContext.layer` so the Workspace tools run against
// a real tempdir filesystem instead of returning their caught-error
// strings.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { describe, expect, it } from "vitest";
import { createAgentRuntime, render } from "@flamecast/agentjsx";
import { createElement, Agent, Block, Messages, Workspace } from "@flamecast/agentjsx/components";
import type { Event, InferFn, ProviderContext } from "@flamecast/agentjsx";

void createElement;

describe("jsx workspace-platform e2e", () => {
  it("runs Workspace tools against a real tempdir when opts.platform is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentjsx-platform-test-"));
    await writeFile(join(root, "hello.txt"), "world");

    const seenContexts: ProviderContext[] = [];
    let turn = 0;
    const infer: InferFn = async (context) => {
      seenContexts.push(context);
      turn++;
      if (turn === 1) {
        return {
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "list_dir",
                arguments: JSON.stringify({ path: "." }),
              },
            },
          ],
        };
      }
      if (turn === 2) {
        return {
          content: "",
          tool_calls: [
            {
              id: "call_2",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "hello.txt" }),
              },
            },
          ],
        };
      }
      return { content: "Done.", tool_calls: [] };
    };

    const agent = createAgentRuntime({
      infer,
      platform: NodeContext.layer,
      context: () =>
        render(
          <Agent>
            <Block name="role">test</Block>
            <Workspace root={root} />
            <Messages />
          </Agent>,
        ),
    });

    try {
      await agent.send("go");

      const finalMsg = await agent.until<Event>((snap) => {
        for (let i = snap.events.length - 1; i >= 0; i--) {
          const e = snap.events[i]!;
          if (e.type === "assistant.message" && e.content === "Done.") {
            return e;
          }
        }
        return null;
      });
      expect(finalMsg.type).toBe("assistant.message");

      const events = await agent.events();

      const listResult = events.find(
        (e) => e.type === "tool.result" && e.tool_call_id === "call_1",
      ) as Extract<Event, { type: "tool.result" }> | undefined;
      expect(listResult).toBeDefined();
      expect(listResult!.content).toContain("hello.txt");
      // It is a real filesystem listing, not an error string.
      expect(listResult!.content).not.toMatch(/^\[list_dir\] Error: /);

      const readResult = events.find(
        (e) => e.type === "tool.result" && e.tool_call_id === "call_2",
      ) as Extract<Event, { type: "tool.result" }> | undefined;
      expect(readResult).toBeDefined();
      expect(readResult!.content.replace(/\n+$/, "")).toBe("world");
      expect(readResult!.content).not.toMatch(/^\[read_file\] Error: /);

      // Sanity: exactly 3 inference turns.
      expect(turn).toBe(3);
      expect(seenContexts.length).toBe(3);
    } finally {
      await agent.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
