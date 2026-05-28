// E2E tests for Skills + Compact + Todo (event-log) JSX capabilities,
// against real on-disk fixtures via NodeContext.layer.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeContext } from "@effect/platform-node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentRuntime, render } from "@flamecast/agentjsx";
import {
  createElement,
  Agent,
  Block,
  Compact,
  Messages,
  Skills,
  Todo,
  Workspace,
} from "@flamecast/agentjsx/components";
import type {
  Event,
  InferFn,
  ProviderContext,
} from "@flamecast/agentjsx";

void createElement;

const systemString = (ctx: ProviderContext): string => {
  if (typeof ctx.system === "string") return ctx.system;
  return ctx.system.map((c) => c.text).join("");
};

const messagesString = (ctx: ProviderContext): string => {
  return JSON.stringify(ctx.messages);
};

describe("jsx skills + compact + todo e2e", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentjsx-skills-compact-test-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("Skills tools resolve markdown bodies and the menu populates after the cache resolves", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "coding-style"), { recursive: true });
    await mkdir(join(root, "pull-request"), { recursive: true });
    await writeFile(
      join(root, "coding-style", "SKILL.md"),
      "Match the surrounding style.\n",
    );
    await writeFile(
      join(root, "pull-request", "SKILL.md"),
      "Open a draft PR early.\n",
    );

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
                name: "skill_lookup",
                arguments: JSON.stringify({ name: "coding-style" }),
              },
            },
          ],
        };
      }
      return { content: "Got the skill content.", tool_calls: [] };
    };

    const agent = createAgentRuntime({
      infer,
      platform: NodeContext.layer,
      context: () =>
        render(
          <Agent>
            <Block name="role">test</Block>
            <Skills root={root} />
            <Messages />
          </Agent>,
        ),
    });

    try {
      await agent.run("go");

      await agent.until<Event>((snap) => {
        for (let i = snap.events.length - 1; i >= 0; i--) {
          const e = snap.events[i]!;
          if (
            e.type === "assistant.message" &&
            e.content === "Got the skill content."
          ) {
            return e;
          }
        }
        return null;
      });

      const events = await agent.events();
      const lookupResult = events.find(
        (e) => e.type === "tool.result" && e.tool_call_id === "call_1",
      ) as Extract<Event, { type: "tool.result" }> | undefined;
      expect(lookupResult).toBeDefined();
      expect(lookupResult!.content).toContain("Match the surrounding style.");

      // The Skills cache is populated by a fire-and-forget Effect kicked
      // off on the first render. There is no ctx.invalidate plumbed
      // through RenderContext today (see skills.tsx), so the loading
      // placeholder lingers until the next natural render. Send another
      // user message to trigger a render and poll the materialized
      // projection until the cache has resolved into the listing. If the
      // first re-render still races the cache fill, keep nudging until
      // the listing appears or the test timeout fires.
      let populated = "";
      for (let attempt = 0; attempt < 10; attempt++) {
        await agent.run(`again-${attempt}`);
        const sys = systemString(await agent.rendered());
        if (sys.includes("coding-style") && sys.includes("pull-request")) {
          populated = sys;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(populated).toContain("coding-style");
      expect(populated).toContain("pull-request");
      expect(populated).toContain("Match the surrounding style.");
      expect(populated).toContain("Open a draft PR early.");
    } finally {
      await agent.dispose();
    }
  });

  it("Todo event-log roundtrip: added/completed events project into the rendered system block", async () => {
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
              id: "t1",
              type: "function",
              function: {
                name: "todo_add",
                arguments: JSON.stringify({ text: "first" }),
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
              id: "t2",
              type: "function",
              function: {
                name: "todo_add",
                arguments: JSON.stringify({ text: "second" }),
              },
            },
          ],
        };
      }
      if (turn === 3) {
        return {
          content: "",
          tool_calls: [
            {
              id: "t3",
              type: "function",
              function: {
                name: "todo_complete",
                arguments: JSON.stringify({ index: 0 }),
              },
            },
          ],
        };
      }
      return { content: "Done.", tool_calls: [] };
    };

    const agent = createAgentRuntime({
      infer,
      context: () =>
        render(
          <Agent>
            <Block name="role">test</Block>
            <Todo />
            <Messages />
          </Agent>,
        ),
    });

    try {
      await agent.run("go");

      await agent.until<Event>((snap) => {
        for (let i = snap.events.length - 1; i >= 0; i--) {
          const e = snap.events[i]!;
          if (e.type === "assistant.message" && e.content === "Done.") {
            return e;
          }
        }
        return null;
      });

      const events = await agent.events();

      const addedEvents = events.filter((e) => e.type === "todo.added") as Array<
        Extract<Event, { type: "todo.added" }>
      >;
      expect(addedEvents.length).toBe(2);
      expect(addedEvents[0]!.text).toBe("first");
      expect(addedEvents[1]!.text).toBe("second");

      const completedEvents = events.filter(
        (e) => e.type === "todo.completed",
      ) as Array<Extract<Event, { type: "todo.completed" }>>;
      expect(completedEvents.length).toBe(1);
      expect(completedEvents[0]!.index).toBe(0);

      const lastCtx = seenContexts.at(-1)!;
      const sys = systemString(lastCtx);
      expect(sys).toContain("[x] 0: first");
      expect(sys).toContain("[ ] 1: second");
    } finally {
      await agent.dispose();
    }
  });

  it("Compact strategy=truncate-tool-outputs truncates oversized tool results in the projection but leaves the log untouched", async () => {
    const bigFile = join(root, "big.txt");
    const bigContent = "x".repeat(5000);
    await writeFile(bigFile, bigContent);

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
              id: "rf1",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "big.txt" }),
              },
            },
          ],
        };
      }
      return { content: "saw it", tool_calls: [] };
    };

    const agent = createAgentRuntime({
      infer,
      platform: NodeContext.layer,
      context: () =>
        render(
          <Agent>
            <Block name="role">test</Block>
            <Workspace root={root} />
            <Compact strategy="truncate-tool-outputs" limit={200}>
              <Messages />
            </Compact>
          </Agent>,
        ),
    });

    try {
      await agent.run("go");

      await agent.until<Event>((snap) => {
        for (let i = snap.events.length - 1; i >= 0; i--) {
          const e = snap.events[i]!;
          if (e.type === "assistant.message" && e.content === "saw it") {
            return e;
          }
        }
        return null;
      });

      const events = await agent.events();

      // The raw tool.result event in the log retains the full output.
      const toolResult = events.find(
        (e) => e.type === "tool.result" && e.tool_call_id === "rf1",
      ) as Extract<Event, { type: "tool.result" }> | undefined;
      expect(toolResult).toBeDefined();
      expect(toolResult!.content).toContain("x".repeat(5000));

      // Turn 2's ProviderContext should NOT contain a 1000-char run of x's
      // — that would only appear if truncation failed.
      const turn2 = seenContexts[1]!;
      const turn2Messages = messagesString(turn2);
      expect(turn2Messages).not.toContain("x".repeat(1000));
      // Sanity: the truncation marker (per compact.tsx) is present.
      expect(turn2Messages).toContain("output truncated");
      // The serialized messages should be well under 5000 chars of x's.
      expect(turn2Messages.length).toBeLessThan(3000);
    } finally {
      await agent.dispose();
    }
  });
});
