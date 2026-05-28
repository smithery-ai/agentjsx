import { describe, expect, it } from "vitest";
import { createAgentRuntime } from "@flamecast/agentjsx";
import type { Fragment, InferFn, ProviderContext } from "@flamecast/agentjsx";

// Oracle tests for the auto-cache-breakpoint contract.
//
// The contract (post PR 4, enforced by the terminal adapter in
// `render-adapter.ts`):
//   Exactly ONE cache_control marker appears in the ProviderContext
//   produced by the render pipeline, UNLESS any fragment already
//   carried explicit `cacheControl` — in which case the auto-marker
//   defers to the caller (no auto-add).
//
// The marker lives either on `context.system` (when system is a
// content-chunk array) or inline on a message content chunk.
//
// These oracles freeze the behavior so a future refactor can't
// silently fracture cache-hit accounting. The load-bearing scenario
// (oracle 4) is the regression for the bug the fix addressed: a
// renderer output with caller-set cacheControl must not produce a
// double-marker.

// Count every cache_control marker in a ProviderContext. Walks system
// content-chunk arrays and per-message content-chunk arrays.
const countCached = (context: ProviderContext): number => {
  let n = 0;
  if (Array.isArray(context.system)) {
    for (const c of context.system) if (c.cacheControl) n++;
  }
  for (const msg of context.messages) {
    if (Array.isArray(msg.content)) {
      for (const c of msg.content) if (c.cacheControl) n++;
    }
  }
  return n;
};

// Find the text of the one cached chunk. Returns null if zero or
// multiple chunks are cached.
const cachedText = (context: ProviderContext): string | null => {
  const hits: string[] = [];
  if (Array.isArray(context.system)) {
    for (const c of context.system) if (c.cacheControl) hits.push(c.text);
  }
  for (const msg of context.messages) {
    if (Array.isArray(msg.content)) {
      for (const c of msg.content) if (c.cacheControl) hits.push(c.text);
    }
  }
  return hits.length === 1 ? hits[0] : null;
};

const capture = (): {
  infer: InferFn;
  seen: () => ProviderContext | null;
} => {
  const captured: ProviderContext[] = [];
  const infer: InferFn = async (context) => {
    captured.push(context);
    return { content: "ack" };
  };
  return { infer, seen: () => captured[0] ?? null };
};

describe("projection: cache-breakpoint oracle", () => {
  it("default path: auto-marks the single ambient system fragment", async () => {
    const { infer, seen } = capture();
    const agent = createAgentRuntime({ infer, system: "You are an agent." });
    try {
      await agent.run("hi");
      await agent.until((s) =>
        s.events.some((e) => e.type === "assistant.message") ? true : null,
      );
      const ctx = seen();
      expect(ctx).not.toBeNull();
      expect(countCached(ctx!)).toBe(1);
      expect(cachedText(ctx!)).toBe("You are an agent.");
      // User message survives as its own message.
      expect(ctx!.messages).toEqual([
        { role: "user", content: "hi" },
      ]);
    } finally {
      await agent.dispose();
    }
  });

  it("cacheAmbient=false: no auto-mark anywhere", async () => {
    const { infer, seen } = capture();
    const agent = createAgentRuntime({
      infer,
      system: "You are an agent.",
      cacheAmbient: false,
    });
    try {
      await agent.run("hi");
      await agent.until((s) =>
        s.events.some((e) => e.type === "assistant.message") ? true : null,
      );
      expect(countCached(seen()!)).toBe(0);
    } finally {
      await agent.dispose();
    }
  });

  it("renderer without caller cacheControl: auto-marks the last system fragment of the RESHAPED result", async () => {
    const { infer, seen } = capture();
    const agent = createAgentRuntime({
      infer,
      system: "seeded ambient",
      // Hook produces a fresh shape with two system fragments and a
      // user message. Auto-marker must find the last system-role
      // fragment of THIS output.
      renderer: ({ events }) => {
        const history: Fragment[] = events
          .filter((e) => e.type === "user.message")
          .map((e, idx) => ({
            tag: "core/user-message",
            source: "history",
            eventSeq: idx,
            content: (e as { content: string }).content,
          }));
        return [
          { tag: "core/system", content: "custom-a", source: "custom-a" },
          { tag: "core/system", content: "custom-b", source: "custom-b" },
          ...history,
        ];
      },
    });
    try {
      await agent.run("hi");
      await agent.until((s) =>
        s.events.some((e) => e.type === "assistant.message") ? true : null,
      );
      const ctx = seen()!;
      expect(countCached(ctx)).toBe(1);
      // Last system-role fragment is "custom-b".
      expect(cachedText(ctx)).toBe("custom-b");
    } finally {
      await agent.dispose();
    }
  });

  it("renderer with caller cacheControl: auto-marker defers, no double-stamp (regression for the bug)", async () => {
    const { infer, seen } = capture();
    const agent = createAgentRuntime({
      infer,
      system: "seeded ambient",
      // Caller-set cacheControl on a fragment mid-render. The OLD code
      // only scanned the ambient slice — it missed the caller's marker
      // and auto-added a second breakpoint. Oracle: exactly one marker.
      renderer: ({ events, ambient }) => {
        const history: Fragment[] = events
          .filter((e) => e.type === "user.message")
          .map((e, idx) => ({
            tag: "core/user-message",
            source: "history",
            eventSeq: idx,
            content: (e as { content: string }).content,
          }));
        const toolDefs: Fragment = {
          tag: "core/system",
          content: "<tools>...</tools>",
          source: "tool-defs",
          cacheControl: { type: "ephemeral" },
        };
        return [...ambient, toolDefs, ...history];
      },
    });
    try {
      await agent.run("hi");
      await agent.until((s) =>
        s.events.some((e) => e.type === "assistant.message") ? true : null,
      );
      const ctx = seen()!;
      expect(countCached(ctx)).toBe(1);
      expect(cachedText(ctx)).toBe("<tools>...</tools>");
    } finally {
      await agent.dispose();
    }
  });

  it("renderer with caller cacheControl on a non-ambient system fragment: auto-mark defers to the caller's pinned fragment", async () => {
    const { infer, seen } = capture();
    const agent = createAgentRuntime({
      infer,
      system: "seeded ambient",
      renderer: ({ ambient }) => [
        ...ambient,
        {
          tag: "core/system",
          source: "pinned",
          content: "pinned",
          cacheControl: { type: "ephemeral" },
        },
      ],
    });
    try {
      await agent.run("hi");
      await agent.until((s) =>
        s.events.some((e) => e.type === "assistant.message") ? true : null,
      );
      const ctx = seen()!;
      expect(countCached(ctx)).toBe(1);
      expect(cachedText(ctx)).toBe("pinned");
    } finally {
      await agent.dispose();
    }
  });
});
