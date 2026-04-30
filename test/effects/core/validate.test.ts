import { describe, expect, it } from "vitest";
import { validateProviderContext } from "effectctx/validate";
import type { ProviderContext } from "effectctx";

const ctx = (
  messages: ProviderContext["messages"],
): ProviderContext => ({
  system: "",
  messages,
  tools: [],
});

describe("validateProviderContext", () => {
  it("accepts a normal user → assistant exchange", () => {
    expect(
      validateProviderContext(
        ctx([
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ]),
      ),
    ).toBeNull();
  });

  it("accepts an assistant turn with text + tool_calls", () => {
    expect(
      validateProviderContext(
        ctx([
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "let me check",
            toolCalls: [
              { id: "t1", type: "function", function: { name: "x", arguments: "{}" } },
            ],
          },
          { role: "tool", toolCallId: "t1", content: "ok" },
        ]),
      ),
    ).toBeNull();
  });

  it("accepts a tool-only assistant turn (text='', toolCalls present)", () => {
    expect(
      validateProviderContext(
        ctx([
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "t1", type: "function", function: { name: "x", arguments: "{}" } },
            ],
          },
          { role: "tool", toolCallId: "t1", content: "ok" },
        ]),
      ),
    ).toBeNull();
  });

  it("rejects a fully-empty assistant turn", () => {
    expect(
      validateProviderContext(
        ctx([
          { role: "user", content: "hi" },
          { role: "assistant", content: "" },
        ]),
      ),
    ).toMatch(/empty.*no text and no tool_calls/);
  });

  it("tolerates a tool message with no preceding assistant tool_call", () => {
    // Compaction.summary boundaries can legitimately collapse the
    // assistant turn that emitted a tool_call while leaving the
    // tool message standing. Compaction-aware providers handle this;
    // the validator stays conservative.
    expect(
      validateProviderContext(
        ctx([
          { role: "user", content: "hi" },
          { role: "tool", toolCallId: "compacted", content: "ok" },
        ]),
      ),
    ).toBeNull();
  });
});
