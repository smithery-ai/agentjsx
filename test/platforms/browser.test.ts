// Typecheck-and-shape smoke test for the Browser platform adapter.
//
// @effect/platform-browser does not export a unified BrowserContext —
// browsers can't supply FileSystem or CommandExecutor. We re-export
// what's available (HttpClient, KeyValueStore, etc.) and provide
// `partialPlatform` wired to the fetch-backed HTTP client.

import { describe, expect, it } from "vitest";
import { Layer } from "effect";
import * as browser from "../../src/platforms/browser";

describe("@flamecast/agentjsx/platforms/browser", () => {
  it("re-exports BrowserHttpClient", () => {
    expect(browser.BrowserHttpClient).toBeDefined();
  });

  it("re-exports BrowserKeyValueStore", () => {
    expect(browser.BrowserKeyValueStore).toBeDefined();
  });

  it("re-exports BrowserRuntime", () => {
    expect(browser.BrowserRuntime).toBeDefined();
    expect(typeof browser.BrowserRuntime.runMain).toBe("function");
  });

  it("exports `partialPlatform` as a Layer (no unified BrowserContext upstream)", () => {
    expect(browser.partialPlatform).toBeDefined();
    expect(Layer.isLayer(browser.partialPlatform)).toBe(true);
  });
});
