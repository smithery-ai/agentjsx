import { Effect, Layer, Schema } from "effect";
import { AgentCtx, defineTool, type Extension } from "@flamecast/agentjsx";
import type { SkillStore } from "../skill-store";

// Mirrors the agent-facing surface of Hermes's curator + skill_usage
// system. Two contributions:
//
//   1. A `manage_skill` tool the model can call: archive | restore |
//      pin | unpin a skill by handle.
//   2. A startup curator pass that transitions skills to "stale" when
//      they have not been used for `staleAfterMs`, and to "archived"
//      when not used for `archiveAfterMs`. Pinned skills are skipped.
//
// Hermes runs the curator as a dedicated background orchestrator. We
// run a single sweep at extension build time — sufficient for a CLI
// run-and-exit shape. For a long-lived agent, schedule the sweep
// from the host (cron, interval, etc.) and call `runCuratorSweep`
// directly.

export interface SkillCuratorOptions {
  readonly store: SkillStore;
  readonly staleAfterMs?: number;
  readonly archiveAfterMs?: number;
  readonly toolName?: string;
  readonly runOnStartup?: boolean;
}

const ACTIONS = ["archive", "restore", "pin", "unpin"] as const;
type Action = (typeof ACTIONS)[number];
const ActionSchema = Schema.Literal(...ACTIONS);

// Default thresholds match Hermes's defaults loosely: stale at 14 days,
// archive at 60 days. Override per loadout.
const DEFAULT_STALE = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_ARCHIVE = 60 * 24 * 60 * 60 * 1000;

export const runCuratorSweep = async (
  store: SkillStore,
  staleAfterMs: number,
  archiveAfterMs: number,
  now: number = Date.now(),
): Promise<{ stale: string[]; archived: string[] }> => {
  const catalog = await store.list();
  const stale: string[] = [];
  const archived: string[] = [];
  for (const entry of catalog) {
    if (entry.usage.pinned) continue;
    const lastTouch = entry.usage.lastUsedAt ?? entry.usage.createdAt;
    const age = now - new Date(lastTouch).getTime();
    if (age >= archiveAfterMs) {
      const ok = await store.archive(entry.handle);
      if (ok) archived.push(entry.handle);
    } else if (age >= staleAfterMs && entry.usage.state !== "stale") {
      await store.markStale(entry.handle);
      stale.push(entry.handle);
    }
  }
  return { stale, archived };
};

export const skillCurator = (opts: SkillCuratorOptions): Extension => {
  const toolName = opts.toolName ?? "manage_skill";
  const staleMs = opts.staleAfterMs ?? DEFAULT_STALE;
  const archiveMs = opts.archiveAfterMs ?? DEFAULT_ARCHIVE;
  const runStart = opts.runOnStartup ?? true;

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;

      if (runStart) {
        yield* Effect.promise(async () => {
          try {
            await runCuratorSweep(opts.store, staleMs, archiveMs);
          } catch {
            // Curator failures must never block agent startup.
          }
        });
      }

      yield* ctx.addTool(
        defineTool({
          name: toolName,
          description:
            "Manage a skill's lifecycle. Actions: 'archive' (move to archive, hide from catalog), " +
            "'restore' (un-archive), 'pin' (exempt from auto-stale/archive), 'unpin'. " +
            "Pinned skills survive curator sweeps regardless of last-used time.",
          parameters: Schema.Struct({
            handle: Schema.String,
            action: ActionSchema,
          }),
          run: async ({ handle, action }) => {
            const a = action as Action;
            switch (a) {
              case "archive": {
                const ok = await opts.store.archive(handle);
                return ok
                  ? `Archived skill "${handle}".`
                  : `Could not archive "${handle}" (already archived or missing).`;
              }
              case "restore": {
                const ok = await opts.store.restore(handle);
                return ok
                  ? `Restored skill "${handle}".`
                  : `Could not restore "${handle}" (not in archive).`;
              }
              case "pin":
                await opts.store.setPinned(handle, true);
                return `Pinned skill "${handle}".`;
              case "unpin":
                await opts.store.setPinned(handle, false);
                return `Unpinned skill "${handle}".`;
            }
          },
        }),
      ).pipe(
        Effect.catchTag("DuplicateToolError", (err) =>
          ctx.reportError("hermes/skill-curator", err),
        ),
      );
    }),
  );
};
