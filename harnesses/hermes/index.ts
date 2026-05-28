// A Hermes-flavored agent, built from effectctx primitives.
//
// What's wired here:
//   localWorkspace   — host shell + filesystem (Hermes's "local" backend)
//   dynamicSkills    — skill catalog refreshed each turn from disk
//   learningLoop     — save_skill / update_skill (write side)
//   userModel        — Honcho-style ambient + update_user_model
//   nudge            — periodic reflection prompt when no memory writes recently
//   todos            — Hermes-style todo tool, event-sourced from the log
//   clarify          — multi-choice/open-ended user clarifications
//   subagents        — Hermes-style delegate_task with read-only child loadout
//   recall           — addressable event-log memory
//   maxSteps         — safety stop
//
// What's deliberately NOT inside this agent (per harnesses/hermes/README.md):
//   - The platform gateway (Telegram/Discord/Slack/...). Process-level.
//   - The cron firing mechanism. Tool surface only would live here; firing
//     is process-level.
//   - The terminal backend chooser (Docker/SSH/Daytona/Modal). Host adapter
//     behind the same `workspace` extension shape.
//   - Curator (autonomous skill lifecycle), session-search (FTS5 over past
//     sessions), send_message (gateway concern). Known gaps — see README.
//
// Run:
//   AI_GATEWAY_API_KEY=... npm run agent "your prompt"

import { createInterface } from "node:readline/promises";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import {
  createAgentRuntime,
  createAiGatewayInfer,
  type Extension,
} from "@flamecast/agentjsx";
import {
  inProcessBackend,
  maxSteps,
  recall,
  subagents,
} from "@flamecast/agentjsx/extensions";
import { localWorkspace } from "@flamecast/agentjsx/node";

import { clarify, type ClarifyHost } from "./extensions/clarify";
import { dynamicSkills } from "./extensions/dynamic-skills";
import { learningLoop } from "./extensions/learning-loop";
import { nudge } from "./extensions/nudge";
import { sessionSearch } from "./extensions/session-search";
import { skillCurator } from "./extensions/skill-curator";
import { todos } from "./extensions/todos";
import { userModel } from "./extensions/user-model";
import { fileSystemSessionStore } from "./session-store";
import { fileSystemSkillStore, type SkillStore } from "./skill-store";
import {
  fileUserModelStore,
  type UserModelStore,
} from "./user-model-store";

const SYSTEM_PROMPT = [
  "You are a Hermes-flavored assistant: you build a deepening model of the",
  "user across sessions, you create skills from experience, you decompose",
  "complex work via the `todo` tool, and you can delegate isolated work to",
  "child agents via `spawn_agent`.",
  "",
  "When you finish a non-trivial task, ask yourself whether any part of what",
  "you did is worth keeping. If yes, call `save_skill`. If a skill you loaded",
  "had a gap, call `update_skill`. When you learn something durable about the",
  "user, call `update_user_model`. The reflection nudge will remind you if",
  "you go several turns without writing anything down.",
  "",
  "Use `clarify` only when you genuinely need user input to proceed. Use",
  "`spawn_agent` for isolated sub-tasks (research, parallel exploration); the",
  "child sees no parent history and returns only its summary.",
].join("\n");

// Hermes's children get a restricted toolset: no recursive delegation,
// no clarify, no memory writes, no skill writes. They DO get read-only
// catalog access and the workspace, matching the spirit of
// DELEGATE_BLOCKED_TOOLS in tools/delegate_tool.py.
const childExtensions =
  (workspaceRoot: string, skillStore: SkillStore, userStore: UserModelStore) =>
  (): Extension[] => [
    localWorkspace({ root: workspaceRoot }),
    dynamicSkills({ store: skillStore }),
    userModel({ store: userStore, readonly: true }),
    todos(),
    recall(),
    maxSteps(20),
  ];

const cliClarifyHost = (): ClarifyHost => ({
  ask: async ({ question, choices }) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`\n${question}`);
      if (choices && choices.length > 0) {
        choices.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
        console.log(`  ${choices.length + 1}. Other (type your answer)`);
        const raw = (await rl.question("> ")).trim();
        const idx = Number.parseInt(raw, 10);
        if (Number.isInteger(idx) && idx >= 1 && idx <= choices.length) {
          return choices[idx - 1];
        }
        return raw;
      }
      return (await rl.question("> ")).trim();
    } finally {
      rl.close();
    }
  },
});

async function main() {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    console.error("Set AI_GATEWAY_API_KEY to a Vercel AI Gateway key.");
    process.exit(1);
  }
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    console.error('Usage: npm run agent "your prompt"');
    process.exit(1);
  }

  const home = resolve(process.cwd(), ".hermes");
  const workspaceRoot = resolve(home, "workspace");
  const skillsRoot = resolve(home, "skills");
  const sessionsRoot = resolve(home, "sessions");
  const userModelPath = resolve(home, "user-model.json");
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(skillsRoot, { recursive: true }),
    mkdir(sessionsRoot, { recursive: true }),
  ]);

  const skillStore = fileSystemSkillStore(skillsRoot);
  const userStore = fileUserModelStore(userModelPath);
  const sessionStore = fileSystemSessionStore(sessionsRoot);

  const infer = createAiGatewayInfer({
    apiKey,
    model: "anthropic/claude-sonnet-4-6",
  });

  const agent = createAgentRuntime({
    system: SYSTEM_PROMPT,
    infer,
    extensions: [
      localWorkspace({ root: workspaceRoot }),
      dynamicSkills({ store: skillStore }),
      learningLoop({ store: skillStore }),
      skillCurator({ store: skillStore }),
      sessionSearch({ store: sessionStore }),
      userModel({ store: userStore }),
      todos(),
      clarify({ host: cliClarifyHost() }),
      subagents({
        backend: inProcessBackend(infer),
        defaultExtensions: childExtensions(
          workspaceRoot,
          skillStore,
          userStore,
        ),
        defaultSystemPrompt:
          "You are a Hermes subagent. You see no parent history. " +
          "Complete the delegated goal and return a concise summary. " +
          "You cannot delegate further or interact with the user.",
        recursion: "deny",
      }),
      nudge(),
      recall(),
      maxSteps(40),
    ],
  });

  await agent.send(prompt);
  const reply = await agent.until((snap) => {
    const last = snap.events.at(-1);
    if (last?.type === "assistant.halted") return { halted: last.reason };
    if (last?.type === "assistant.message" && last.content.length > 0) {
      return { text: last.content };
    }
    return null;
  });

  if ("halted" in reply) {
    console.error(`Agent halted: ${reply.halted}`);
  } else {
    console.log(reply.text);
  }

  await agent.dispose();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
