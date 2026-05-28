import { Effect, Layer, Schema } from "effect";
import { AgentCtx } from "../core/agent-ctx";
import type { Extension } from "../core/agent";
import { registerTool } from "./tool-registration";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// The shell backend. The `shell()` extension ships the tools and the
// ambient cwd block; the backend actually executes commands. Same
// dependency-inversion pattern as fileSystem.
//
// SECURITY CONTRACT. The `bash` tool exposed by `shell()` runs
// arbitrary LLM-authored commands. The harness performs no allowlist,
// denylist, or string sanitization. All safety depends on the backend
// being a real isolation boundary — ephemeral per-session sandbox with
// filesystem scope, resource limits, and wall-clock caps enforced
// server-side regardless of the LLM-supplied timeout the extension
// clamps to `maxTimeout` defensively.
export interface Shell {
  exec(
    cmd: string,
    opts?: { cwd?: string; timeout?: number; env?: Record<string, string> },
  ): Promise<ExecResult>;
}

export interface ShellOptions {
  // Initial working directory. Default "/".
  cwd?: string;
  // Default timeout applied to bash calls that don't specify one. Default 60_000 ms.
  defaultTimeout?: number;
  // Hard ceiling on per-call timeout. LLM-supplied values above this are
  // silently clamped. Defense in depth — backends still MUST enforce
  // their own server-side wall-clock limits. Default 900_000 ms.
  maxTimeout?: number;
}

// Contributes `bash` and `cd` tools plus a reactive `cwd` ambient
// block. The cwd is harness-managed, not backend-held — each exec
// call passes `cwd` explicitly so shells that spawn a new process per
// command produce consistent behavior.
export const shell = (sh: Shell, opts: ShellOptions = {}): Extension => {
  const initialCwd = opts.cwd ?? "/";
  const defaultTimeout = opts.defaultTimeout ?? 60_000;
  const maxTimeout = opts.maxTimeout ?? 900_000;

  return Layer.scopedDiscard(
    Effect.gen(function* () {
      const ctx = yield* AgentCtx;
      let currentCwd = initialCwd;

      yield* ctx.addAmbient({
        name: "cwd",
        content: Effect.sync(() => `Current working directory: ${currentCwd}`),
      });

      yield* registerTool(ctx, "shell", {
        name: "bash",
        description: `Execute a shell command in the current working directory. Returns stdout, stderr, and exit code. Timeout defaults to ${defaultTimeout}ms, max ${maxTimeout}ms (values above the max are clamped). Use the \`cd\` tool to persist cwd changes across calls; passing \`cwd\` here only scopes this one invocation.`,
        parameters: Schema.Struct({
          cmd: Schema.String.annotations({ description: "Shell command to execute." }),
          cwd: Schema.String.annotations({
            description:
              "Override working directory for this call only. Omit to use the persistent cwd.",
          }).pipe(Schema.optionalWith({ nullable: true })),
          timeout: Schema.Number.annotations({
            description: `Timeout in milliseconds. Default ${defaultTimeout}, maximum ${maxTimeout} (larger values are clamped). Command is killed if exceeded.`,
          }).pipe(Schema.optionalWith({ nullable: true })),
        }),
        run: async (args) => {
          const requested =
            args.timeout !== undefined && Number.isFinite(args.timeout) && args.timeout > 0
              ? args.timeout
              : defaultTimeout;
          const timeout = Math.min(requested, maxTimeout);
          const result = await sh.exec(args.cmd, {
            cwd: args.cwd ?? currentCwd,
            timeout,
          });
          return formatResult(result);
        },
      });

      yield* registerTool(ctx, "shell", {
        name: "cd",
        description:
          "Change the persistent working directory used by subsequent bash commands.",
        parameters: Schema.Struct({
          path: Schema.String.annotations({ description: "New working directory path." }),
        }),
        run: async (args) => {
          currentCwd = args.path;
          return `cwd -> ${args.path}`;
        },
      });
    }),
  );
};

function formatResult(r: ExecResult): string {
  const parts: string[] = [];
  const out = r.stdout.trim();
  const err = r.stderr.trim();
  if (out) parts.push(out);
  if (err) parts.push(`[stderr]\n${err}`);
  parts.push(`[exit code: ${r.exitCode}]`);
  return parts.join("\n\n");
}
