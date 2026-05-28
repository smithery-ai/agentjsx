// Behavioral parity scenarios for the Hermes-flavored harness.
//
// "Functionally matches Hermes" is too broad — Hermes ships subsystems
// this harness deliberately omits (gateways, scheduler, FTS5, voice).
// Instead we pin down five contracts we DO claim to preserve, and
// exercise each via a scripted session in a simulated world (tmp dir
// for state, scriptedInfer for the model). Determinism comes from
// scripting the model's tool calls; behavioral evidence comes from
// observing the disk + ambient fragments + event log afterwards.
//
// Contracts under test:
//   1. Catalog freshness — save_skill → next turn ambient lists it.
//   2. Cross-session persistence — agent A saves; new agent B on the
//      same store sees skills + user-model entries.
//   3. Skill self-improvement — update_skill replaces the body; later
//      load_skill returns the new body.
//   4. User-model upsert + ambient — entries appear in the "Who you're
//      talking to" fragment.
//   5. Nudge fires after N quiet turns; clears after one persist call.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createAgentRuntime,
  type AgentSnapshot,
  type Event,
  type InferFn,
  type ProviderContext,
} from "@flamecast/agentjsx";
import { inProcessBackend, recall, subagents } from "@flamecast/agentjsx/extensions";

import { clarify } from "../extensions/clarify";
import { dynamicSkills } from "../extensions/dynamic-skills";
import { learningLoop } from "../extensions/learning-loop";
import { nudge } from "../extensions/nudge";
import { sessionSearch } from "../extensions/session-search";
import {
  runCuratorSweep,
  skillCurator,
} from "../extensions/skill-curator";
import { todos } from "../extensions/todos";
import { userModel } from "../extensions/user-model";
import { fileSystemSessionStore } from "../session-store";
import { fileSystemSkillStore } from "../skill-store";
import { fileUserModelStore } from "../user-model-store";
import {
  scriptedInfer,
  toolCall,
  type ScriptedStep,
} from "../../../test/agentctx/helpers/scripted-infer";

const systemText = (snap: AgentSnapshot): string =>
  typeof snap.rendered.system === "string"
    ? snap.rendered.system
    : snap.rendered.system.map((c) => c.text).join("\n\n");

const waitForResult = (
  agent: ReturnType<typeof createAgentRuntime>,
  id: string,
): Promise<Event> =>
  agent.until((s) => {
    const hit = s.events.find(
      (e) => e.type === "tool.result" && e.tool_call_id === id,
    );
    return hit ?? null;
  });

const waitForFinalAssistant = (agent: ReturnType<typeof createAgentRuntime>) =>
  agent.until((s) => {
    const last = s.events.at(-1);
    if (
      last?.type === "assistant.message" &&
      !last.tool_calls?.length
    ) {
      return last;
    }
    return null;
  });

const buildAgent = (
  home: string,
  steps: ReadonlyArray<ScriptedStep>,
  opts: { nudgeThreshold?: number } = {},
) => {
  const skillStore = fileSystemSkillStore(join(home, "skills"));
  const userStore = fileUserModelStore(join(home, "user-model.json"));
  const agent = createAgentRuntime({
    system: "test",
    infer: scriptedInfer(steps),
    extensions: [
      dynamicSkills({ store: skillStore }),
      learningLoop({ store: skillStore }),
      userModel({ store: userStore }),
      todos(),
      nudge({ threshold: opts.nudgeThreshold ?? 6 }),
      recall(),
    ],
  });
  return { agent, skillStore, userStore };
};

describe("hermes harness: behavioral parity scenarios", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hermes-harness-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("catalog freshness: a saved skill appears in the next turn's system block", async () => {
    const { agent } = buildAgent(home, [
      // Turn 1: model saves a skill.
      {
        content: "",
        tool_calls: [
          toolCall("c1", "save_skill", {
            name: "summarize-pr",
            description: "Summarize a PR diff into a changelog entry.",
            body: "# Summarize PR\n\nRead diff. Group by file. One bullet each.",
          }),
        ],
      },
      // Turn 1 cont: model finalizes after seeing tool.result.
      { content: "saved" },
    ]);
    try {
      agent.send("save a skill");
      await waitForResult(agent, "c1");
      await waitForFinalAssistant(agent);

      const snap = await agent.until((s) =>
        systemText(s).includes("summarize-pr") ? s : null,
      );
      const sys = systemText(snap);
      expect(sys).toContain("summarize-pr");
      expect(sys).toContain("Summarize a PR diff into a changelog entry.");
    } finally {
      await agent.dispose();
    }
  });

  it("cross-session persistence: a fresh agent sees skills + user-model entries from a prior agent", async () => {
    // Session 1: save a skill and an entry.
    const a = buildAgent(home, [
      {
        content: "",
        tool_calls: [
          toolCall("c1", "save_skill", {
            name: "deploy",
            description: "Deploy to prod.",
            body: "# Deploy\n\npreflight; push.",
          }),
          toolCall("c2", "update_user_model", {
            key: "editor",
            value: "neovim",
          }),
        ],
      },
      { content: "ok" },
    ]);
    try {
      a.agent.send("set up");
      await waitForResult(a.agent, "c1");
      await waitForResult(a.agent, "c2");
      await waitForFinalAssistant(a.agent);
    } finally {
      await a.agent.dispose();
    }

    // Disk state confirms the writes — same shape Hermes produces.
    const onDisk = await readFile(join(home, "user-model.json"), "utf8");
    expect(JSON.parse(onDisk)).toEqual([{ key: "editor", value: "neovim" }]);

    // Session 2: brand new agent, same store. Ambient should include both.
    const b = buildAgent(home, [{ content: "ack" }]);
    try {
      b.agent.send("hi");
      const snap = await b.agent.until((s) => {
        const sys = systemText(s);
        return sys.includes("deploy") && sys.includes("neovim") ? s : null;
      });
      const sys = systemText(snap);
      expect(sys).toContain("deploy");
      expect(sys).toContain("Deploy to prod.");
      expect(sys).toContain("**editor**: neovim");
    } finally {
      await b.agent.dispose();
    }
  });

  it("skill self-improvement: update_skill rewrites the body returned by load_skill", async () => {
    // Pre-seed one skill so the model can update it.
    const seed = buildAgent(home, [
      {
        content: "",
        tool_calls: [
          toolCall("c1", "save_skill", {
            name: "triage",
            description: "Triage bugs.",
            body: "# v1\n\nstep one.",
          }),
        ],
      },
      { content: "saved" },
    ]);
    try {
      seed.agent.send("seed");
      await waitForResult(seed.agent, "c1");
      await waitForFinalAssistant(seed.agent);
    } finally {
      await seed.agent.dispose();
    }

    // New session: load (verify v1), update, reload, verify v2.
    const { agent } = buildAgent(home, [
      {
        content: "",
        tool_calls: [toolCall("l1", "load_skill", { name: "triage" })],
      },
      {
        content: "",
        tool_calls: [
          toolCall("u1", "update_skill", {
            handle: "triage",
            name: "triage",
            description: "Triage bugs (improved).",
            body: "# v2\n\nstep one. step two.",
          }),
        ],
      },
      {
        content: "",
        tool_calls: [toolCall("l2", "load_skill", { name: "triage" })],
      },
      { content: "done" },
    ]);
    try {
      agent.send("improve triage");
      const r1 = await waitForResult(agent, "l1");
      const c1 = "content" in r1 ? r1.content : "";
      expect(c1).toContain("# v1");

      await waitForResult(agent, "u1");
      const r2 = await waitForResult(agent, "l2");
      const c2 = "content" in r2 ? r2.content : "";
      expect(c2).toContain("# v2");
      expect(c2).toContain("step two");
      expect(c2).not.toContain("# v1");
    } finally {
      await agent.dispose();
    }
  });

  it("todos: writing a list surfaces it in the ambient; a second write replaces it", async () => {
    const { agent } = buildAgent(home, [
      {
        content: "",
        tool_calls: [
          toolCall("t1", "todo", {
            todos: [
              { id: "a", content: "investigate", status: "in_progress" },
              { id: "b", content: "write fix", status: "pending" },
            ],
          }),
        ],
      },
      {
        content: "",
        tool_calls: [
          toolCall("t2", "todo", {
            todos: [
              { id: "a", content: "investigate", status: "completed" },
              { id: "b", content: "write fix", status: "in_progress" },
              { id: "c", content: "add test", status: "pending" },
            ],
          }),
        ],
      },
      { content: "done" },
    ]);
    try {
      agent.send("plan");
      await waitForResult(agent, "t1");
      const after1 = await agent.until((s) =>
        systemText(s).includes("write fix") ? s : null,
      );
      const sys1 = systemText(after1);
      expect(sys1).toContain("investigate");
      expect(sys1).toContain("(a, in_progress)");
      expect(sys1).toContain("write fix");
      expect(sys1).not.toContain("add test");

      await waitForResult(agent, "t2");
      const after2 = await agent.until((s) =>
        systemText(s).includes("add test") ? s : null,
      );
      const sys2 = systemText(after2);
      expect(sys2).toContain("(a, completed)");
      expect(sys2).toContain("(b, in_progress)");
      expect(sys2).toContain("(c, pending)");
    } finally {
      await agent.dispose();
    }
  });

  it("todos: rejects duplicate ids", async () => {
    const { agent } = buildAgent(home, [
      {
        content: "",
        tool_calls: [
          toolCall("t1", "todo", {
            todos: [
              { id: "a", content: "x", status: "pending" },
              { id: "a", content: "y", status: "pending" },
            ],
          }),
        ],
      },
      { content: "ack" },
    ]);
    try {
      agent.send("plan");
      const r = await waitForResult(agent, "t1");
      const content = "content" in r ? r.content : "";
      expect(content).toMatch(/duplicate todo id/);
    } finally {
      await agent.dispose();
    }
  });

  it("clarify: invokes the host callback with question + choices, returns the answer", async () => {
    let received: { question: string; choices?: readonly string[] } | null =
      null;
    const host = {
      ask: async (req: { question: string; choices?: readonly string[] }) => {
        received = req;
        return "neovim";
      },
    };

    const skillStore = fileSystemSkillStore(join(home, "skills"));
    const userStore = fileUserModelStore(join(home, "user-model.json"));
    const agent = createAgentRuntime({
      system: "test",
      infer: scriptedInfer([
        {
          content: "",
          tool_calls: [
            toolCall("q1", "clarify", {
              question: "Which editor?",
              choices: ["vscode", "neovim", "emacs"],
            }),
          ],
        },
        { content: "got it" },
      ]),
      extensions: [
        dynamicSkills({ store: skillStore }),
        learningLoop({ store: skillStore }),
        userModel({ store: userStore }),
        clarify({ host }),
        recall(),
      ],
    });
    try {
      agent.send("ask me");
      const r = await waitForResult(agent, "q1");
      const content = "content" in r ? r.content : "";
      expect(JSON.parse(content)).toEqual({ answer: "neovim" });
      expect(received).not.toBeNull();
      expect(received!.question).toBe("Which editor?");
      expect(received!.choices).toEqual(["vscode", "neovim", "emacs"]);
    } finally {
      await agent.dispose();
    }
  });

  it("clarify: rejects more than 4 choices", async () => {
    const host = { ask: async () => "should not be called" };
    const skillStore = fileSystemSkillStore(join(home, "skills"));
    const userStore = fileUserModelStore(join(home, "user-model.json"));
    const agent = createAgentRuntime({
      system: "test",
      infer: scriptedInfer([
        {
          content: "",
          tool_calls: [
            toolCall("q1", "clarify", {
              question: "?",
              choices: ["a", "b", "c", "d", "e"],
            }),
          ],
        },
        { content: "ack" },
      ]),
      extensions: [clarify({ host })],
    });
    try {
      agent.send("x");
      const r = await waitForResult(agent, "q1");
      const content = "content" in r ? r.content : "";
      expect(content).toMatch(/at most 4 choices/);
    } finally {
      await agent.dispose();
    }
  });

  it("subagents: parent delegate spawns child with restricted toolset; child result returns to parent", async () => {
    let childTools: readonly string[] | null = null;
    const childInfer: InferFn = async (context: ProviderContext) => {
      childTools = context.tools.map((t) => t.name);
      return { content: "found 3 TODOs in src/" };
    };
    const parentInfer = scriptedInfer([
      {
        content: "",
        tool_calls: [
          toolCall("d1", "spawn_agent", {
            prompt: "scan src/ for TODO comments",
          }),
        ],
      },
      { content: "summary delivered" },
    ]);

    // Multiplex parent vs child by inference call: parent calls infer
    // through its own runtime; child uses the inProcessBackend's infer.
    const skillStore = fileSystemSkillStore(join(home, "skills"));
    const userStore = fileUserModelStore(join(home, "user-model.json"));
    const agent = createAgentRuntime({
      system: "parent",
      infer: parentInfer,
      extensions: [
        dynamicSkills({ store: skillStore }),
        learningLoop({ store: skillStore }),
        userModel({ store: userStore }),
        clarify({ host: { ask: async () => "" } }),
        todos(),
        subagents({
          backend: inProcessBackend(childInfer),
          defaultExtensions: () => [
            dynamicSkills({ store: skillStore }),
            userModel({ store: userStore, readonly: true }),
            todos(),
            recall(),
          ],
          defaultSystemPrompt: "child",
          recursion: "deny",
        }),
        recall(),
      ],
    });
    try {
      agent.send("delegate");
      const r = await waitForResult(agent, "d1");
      const content = "content" in r ? r.content : "";
      expect(content).toContain("found 3 TODOs");

      // Child must NOT see parent-only tools. This is the Hermes
      // DELEGATE_BLOCKED_TOOLS contract.
      expect(childTools).not.toBeNull();
      const names = new Set(childTools ?? []);
      expect(names.has("spawn_agent")).toBe(false);
      expect(names.has("clarify")).toBe(false);
      expect(names.has("save_skill")).toBe(false);
      expect(names.has("update_skill")).toBe(false);
      expect(names.has("update_user_model")).toBe(false);
      // ...but the child DOES have read-only access:
      expect(names.has("load_skill")).toBe(true);
      expect(names.has("todo")).toBe(true);
      expect(names.has("recall")).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it("skill usage: load_skill bumps useCount; update_skill bumps patchCount", async () => {
    // Pre-seed a skill so we can load and update it.
    const skillStore = fileSystemSkillStore(join(home, "skills"));
    const userStore = fileUserModelStore(join(home, "user-model.json"));
    const seeded = await skillStore.save({
      name: "deploy",
      description: "Deploy to prod.",
      body: "# Deploy\n\npreflight; push.",
    });
    expect(seeded.usage.useCount).toBe(0);

    const agent = createAgentRuntime({
      system: "test",
      infer: scriptedInfer([
        {
          content: "",
          tool_calls: [toolCall("l1", "load_skill", { name: "deploy" })],
        },
        {
          content: "",
          tool_calls: [
            toolCall("u1", "update_skill", {
              handle: seeded.handle,
              name: "deploy",
              description: "Deploy to prod.",
              body: "# Deploy v2\n\npreflight; push; verify.",
            }),
          ],
        },
        { content: "done" },
      ]),
      extensions: [
        dynamicSkills({ store: skillStore }),
        learningLoop({ store: skillStore }),
        userModel({ store: userStore }),
        recall(),
      ],
    });
    try {
      agent.send("use it");
      await waitForResult(agent, "l1");
      await waitForResult(agent, "u1");
      await waitForFinalAssistant(agent);

      const after = (await skillStore.list()).find(
        (s) => s.handle === seeded.handle,
      );
      expect(after).toBeDefined();
      expect(after!.usage.useCount).toBeGreaterThanOrEqual(1);
      expect(after!.usage.viewCount).toBeGreaterThanOrEqual(1);
      expect(after!.usage.patchCount).toBeGreaterThanOrEqual(1);
      expect(after!.usage.lastUsedAt).not.toBeNull();
      expect(after!.usage.lastPatchedAt).not.toBeNull();
    } finally {
      await agent.dispose();
    }
  });

  it("curator sweep: stale, then archive — pinned skills are exempt", async () => {
    const skillStore = fileSystemSkillStore(join(home, "skills"));

    const a = await skillStore.save({
      name: "old",
      description: "ancient skill",
      body: "# old",
    });
    const b = await skillStore.save({
      name: "pinned-old",
      description: "ancient but pinned",
      body: "# pinned",
    });
    await skillStore.setPinned(b.handle, true);

    // Pretend "now" is far in the future so both skills look stale/old.
    const future = Date.now() + 365 * 24 * 60 * 60 * 1000;
    const staleMs = 14 * 24 * 60 * 60 * 1000;
    const archiveMs = 60 * 24 * 60 * 60 * 1000;

    const result = await runCuratorSweep(
      skillStore,
      staleMs,
      archiveMs,
      future,
    );

    // The unpinned skill is past archive threshold → archived.
    expect(result.archived).toContain(a.handle);
    // The pinned skill is exempt from both transitions.
    expect(result.archived).not.toContain(b.handle);
    expect(result.stale).not.toContain(b.handle);

    const visible = await skillStore.list();
    expect(visible.find((s) => s.handle === a.handle)).toBeUndefined();
    expect(visible.find((s) => s.handle === b.handle)).toBeDefined();

    const withArchive = await skillStore.list({ includeArchived: true });
    expect(withArchive.find((s) => s.handle === a.handle)?.usage.state).toBe(
      "archived",
    );
  });

  it("manage_skill: archive removes from catalog; restore brings it back", async () => {
    const skillStore = fileSystemSkillStore(join(home, "skills"));
    const userStore = fileUserModelStore(join(home, "user-model.json"));
    const seeded = await skillStore.save({
      name: "obsolete",
      description: "no longer needed",
      body: "# obsolete",
    });

    const agent = createAgentRuntime({
      system: "test",
      infer: scriptedInfer([
        {
          content: "",
          tool_calls: [
            toolCall("m1", "manage_skill", {
              handle: seeded.handle,
              action: "archive",
            }),
          ],
        },
        { content: "archived" },
      ]),
      extensions: [
        dynamicSkills({ store: skillStore }),
        learningLoop({ store: skillStore }),
        userModel({ store: userStore }),
        skillCurator({ store: skillStore, runOnStartup: false }),
      ],
    });
    try {
      agent.send("clean up");
      await waitForResult(agent, "m1");
      await waitForFinalAssistant(agent);

      const visible = await skillStore.list();
      expect(visible.find((s) => s.handle === seeded.handle)).toBeUndefined();

      const restored = await skillStore.restore(seeded.handle);
      expect(restored).toBe(true);
      const visibleAgain = await skillStore.list();
      expect(visibleAgain.find((s) => s.handle === seeded.handle)).toBeDefined();
    } finally {
      await agent.dispose();
    }
  });

  it("session search: browse mode returns recent sessions; query mode ranks matches", async () => {
    const sessionStore = fileSystemSessionStore(join(home, "sessions"));
    await sessionStore.addSession({
      id: "s-001",
      title: "Investigating the migration bug",
      startedAt: "2026-04-20T10:00:00.000Z",
      messages: [
        { role: "user", content: "the migration is failing on prod" },
        {
          role: "assistant",
          content:
            "Looking at the migration script. The issue is in 0042_user_schema.sql.",
        },
      ],
    });
    await sessionStore.addSession({
      id: "s-002",
      title: "Refactoring the auth middleware",
      startedAt: "2026-04-25T09:00:00.000Z",
      messages: [
        { role: "user", content: "rewrite the auth middleware" },
        { role: "assistant", content: "Done. Tests pass." },
      ],
    });
    await sessionStore.addSession({
      id: "s-003",
      title: "Adding tests for the migration runner",
      startedAt: "2026-04-26T15:00:00.000Z",
      messages: [
        { role: "user", content: "add migration tests" },
        {
          role: "assistant",
          content: "Added unit tests for the migration runner.",
        },
      ],
    });

    const agent = createAgentRuntime({
      system: "test",
      infer: scriptedInfer([
        // Browse mode.
        {
          content: "",
          tool_calls: [toolCall("b1", "session_search", {})],
        },
        // Query mode.
        {
          content: "",
          tool_calls: [
            toolCall("q1", "session_search", { query: "migration" }),
          ],
        },
        { content: "done" },
      ]),
      extensions: [sessionSearch({ store: sessionStore })],
    });
    try {
      agent.send("recall");
      const browse = await waitForResult(agent, "b1");
      const browseContent = "content" in browse ? browse.content : "";
      const browseList = JSON.parse(browseContent) as Array<{ id: string }>;
      // Most recent first.
      expect(browseList[0].id).toBe("s-003");
      expect(browseList.length).toBeLessThanOrEqual(3);

      const query = await waitForResult(agent, "q1");
      const queryContent = "content" in query ? query.content : "";
      const queryList = JSON.parse(queryContent) as Array<{
        id: string;
        score: number;
        excerpt: string;
      }>;
      // Both s-001 and s-003 mention "migration"; s-002 doesn't.
      const ids = queryList.map((m) => m.id);
      expect(ids).toContain("s-001");
      expect(ids).toContain("s-003");
      expect(ids).not.toContain("s-002");
      // Scores reflect hit count; excerpts are non-empty.
      for (const m of queryList) {
        expect(m.score).toBeGreaterThan(0);
        expect(m.excerpt.length).toBeGreaterThan(0);
      }
    } finally {
      await agent.dispose();
    }
  });

  it("nudge contract: appears after threshold quiet turns, clears after one persist call", async () => {
    // Threshold=2 to keep the script tight. Drive 3 quiet turns then one
    // save_skill — assert nudge present before, gone after.
    const { agent } = buildAgent(
      home,
      [
        { content: "ok 1" },
        { content: "ok 2" },
        { content: "ok 3" },
        {
          content: "",
          tool_calls: [
            toolCall("s1", "save_skill", {
              name: "noted",
              description: "Reminder applied.",
              body: "# noted",
            }),
          ],
        },
        { content: "after save" },
      ],
      { nudgeThreshold: 2 },
    );
    try {
      // Three quiet user→assistant turns. After the 3rd, two completed
      // turns sit before any persist call — nudge fires.
      agent.send("u1");
      await waitForFinalAssistant(agent);
      agent.send("u2");
      await waitForFinalAssistant(agent);
      agent.send("u3");
      await waitForFinalAssistant(agent);

      const before = await agent.until((s) =>
        systemText(s).includes("Reflection nudge") ? s : null,
      );
      expect(systemText(before)).toContain("Reflection nudge");

      // Now drive a turn that calls save_skill — the nudge should clear.
      agent.send("u4 — save something");
      await waitForResult(agent, "s1");
      await waitForFinalAssistant(agent);

      const after = await agent.until((s) =>
        systemText(s).includes("Reflection nudge") ? null : s,
      );
      expect(systemText(after)).not.toContain("Reflection nudge");
    } finally {
      await agent.dispose();
    }
  });
});
