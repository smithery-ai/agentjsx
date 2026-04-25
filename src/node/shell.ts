import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Shell } from "../extensions/shell";

const execAsync = promisify(exec);

// SECURITY: this Shell shells out on the host process. There is no
// sandbox, no resource ceiling, no allowlist. The model can run any
// command the user running the process can run. Use this only for
// trusted local dev. For anything else, write your own Shell adapter
// that calls into a real isolation boundary (Docker, Firecracker,
// Cloudflare Sandbox, etc.).
export const nodeShell = (): Shell => ({
  exec: async (cmd, opts) => {
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: opts?.cwd,
        timeout: opts?.timeout,
        env: { ...process.env, ...opts?.env },
        maxBuffer: 10 * 1024 * 1024,
      });
      return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
    } catch (e) {
      const err = e as {
        stdout?: string;
        stderr?: string;
        code?: number;
        message?: string;
      };
      return {
        stdout: String(err.stdout ?? ""),
        stderr: String(err.stderr ?? err.message ?? ""),
        exitCode: typeof err.code === "number" ? err.code : 1,
      };
    }
  },
});
