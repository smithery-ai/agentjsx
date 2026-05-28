import { describe, expect, it } from "vitest";
import { createAgentRuntime, skills } from "@flamecast/agentjsx";
import type { Event } from "@flamecast/agentjsx";
import { scriptedInfer, toolCall } from "../helpers/scripted-infer";

const CATALOG = [
  { name: "triage", description: "Triage bug reports.", handle: "h-triage" },
  { name: "deploy", description: "Deploy to prod.", handle: "h-deploy" },
];
const BODIES: Record<string, string> = {
  "h-triage": "# Triage skill\n\nStep 1: reproduce.\nStep 2: narrow.",
  "h-deploy": "# Deploy skill\n\nStep 1: preflight.\nStep 2: push.",
};
const backend = {
  async read(handle: string) {
    return BODIES[handle] ?? null;
  },
};

const waitForResult = async (
  agent: ReturnType<typeof createAgentRuntime>,
  id: string,
): Promise<Event> =>
  agent.until((s) => {
    const hit = s.events.find((e) => e.type === "tool.result" && e.tool_call_id === id);
    return hit ?? null;
  });

describe("agentctx: skills extension", () => {
  it("adds the skills menu block and the load_skill tool", async () => {
    const agent = createAgentRuntime({
      infer: scriptedInfer([{ content: "ack" }]),
      extensions: [skills({ skills: CATALOG, backend })],
    });
    try {
      agent.send("hi");
      const sys = await agent.until((s) => {
        const text = typeof s.rendered.system === "string"
          ? s.rendered.system
          : s.rendered.system.map((c) => c.text).join("\n\n");
        return text.includes("Available skills") ? text : null;
      });
      expect(sys).toContain("triage");
      expect(sys).toContain("Triage bug reports.");
      expect(sys).toContain("deploy");
    } finally {
      await agent.dispose();
    }
  });

  it("invokes backend.read and returns the body verbatim", async () => {
    const agent = createAgentRuntime({
      infer: scriptedInfer([
        { content: "", tool_calls: [toolCall("c1", "load_skill", { name: "triage" })] },
        { content: "loaded" },
      ]),
      extensions: [skills({ skills: CATALOG, backend })],
    });
    try {
      agent.send("use triage");
      const result = await waitForResult(agent, "c1");
      const content = "content" in result ? result.content : "";
      expect(content).toBe(BODIES["h-triage"]);
    } finally {
      await agent.dispose();
    }
  });

  it("returns a helpful error for an unknown skill name", async () => {
    const agent = createAgentRuntime({
      infer: scriptedInfer([
        {
          content: "",
          tool_calls: [toolCall("c1", "load_skill", { name: "does-not-exist" })],
        },
        { content: "ok" },
      ]),
      extensions: [skills({ skills: CATALOG, backend })],
    });
    try {
      agent.send("x");
      const result = await waitForResult(agent, "c1");
      const content = "content" in result ? result.content : "";
      expect(content).toMatch(/Unknown skill/);
      expect(content).toMatch(/triage/);
      expect(content).toMatch(/deploy/);
    } finally {
      await agent.dispose();
    }
  });
});
