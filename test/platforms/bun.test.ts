// Typecheck-and-shape smoke test for the Bun platform adapter.
//
// Vitest runs on Node, not Bun, so we can't drive a real Bun runtime
// from here. The test asserts the imports resolve, the layer is the
// expected shape, and the namespace re-exports are intact.

import { describe, expect, it } from "vitest";
import { Layer } from "effect";
import * as bun from "../../src/platforms/bun";

describe("@flamecast/agentjsx/platforms/bun", () => {
  it("re-exports BunContext", () => {
    expect(bun.BunContext).toBeDefined();
    expect(bun.BunContext.layer).toBeDefined();
  });

  it("re-exports BunRuntime", () => {
    expect(bun.BunRuntime).toBeDefined();
    expect(typeof bun.BunRuntime.runMain).toBe("function");
  });

  it("exports `platform` as a Layer wired to BunContext.layer", () => {
    expect(bun.platform).toBeDefined();
    expect(Layer.isLayer(bun.platform)).toBe(true);
    expect(bun.platform).toBe(bun.BunContext.layer);
  });
});
