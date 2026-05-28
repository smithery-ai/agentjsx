import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  localWorkspace,
  nodeFileStore,
  nodeShell,
} from "@flamecast/agentjsx/node";
import { createAgentRuntime } from "@flamecast/agentjsx";
import { scriptedInfer } from "../helpers/scripted-infer";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agentctx-node-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("nodeShell", () => {
  it("captures stdout from a successful command", async () => {
    const sh = nodeShell();
    const result = await sh.exec("echo hello-world");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello-world");
  });

  it("returns a non-zero exit and stderr for a failing command", async () => {
    const sh = nodeShell();
    const result = await sh.exec("ls /definitely-not-a-real-path-xyz");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it("respects cwd", async () => {
    const sh = nodeShell();
    await writeFile(join(root, "marker.txt"), "x");
    const result = await sh.exec("ls", { cwd: root });
    expect(result.stdout).toContain("marker.txt");
  });
});

describe("nodeFileStore", () => {
  it("writes and reads a file", async () => {
    const fs = nodeFileStore(root);
    await fs.write("hello.txt", "first");
    const got = await fs.read("hello.txt");
    expect(got).toBe("first");
  });

  it("creates parent directories on write", async () => {
    const fs = nodeFileStore(root);
    await fs.write("nested/deep/file.txt", "ok");
    const onDisk = await readFile(join(root, "nested/deep/file.txt"), "utf8");
    expect(onDisk).toBe("ok");
  });

  it("returns null for a missing file rather than throwing", async () => {
    const fs = nodeFileStore(root);
    expect(await fs.read("nope.txt")).toBeNull();
    expect(await fs.stat("nope.txt")).toBeNull();
  });

  it("lists a directory", async () => {
    const fs = nodeFileStore(root);
    await fs.write("a.txt", "x");
    await fs.write("b.txt", "y");
    const entries = await fs.list("/");
    const names = entries.map((e) => e.path).sort();
    expect(names).toEqual(["a.txt", "b.txt"]);
  });

  it("deletes files", async () => {
    const fs = nodeFileStore(root);
    await fs.write("doomed.txt", "x");
    await fs.delete("doomed.txt");
    expect(await fs.read("doomed.txt")).toBeNull();
  });
});

describe("localWorkspace", () => {
  it("composes into createAgentRuntime and exposes shell + filesystem tools after the first turn", async () => {
    const agent = createAgentRuntime({
      infer: scriptedInfer([{ content: "ok" }]),
      extensions: [localWorkspace({ root })],
    });
    try {
      void agent.send("go");
      await agent.until((s) => {
        const last = s.events.at(-1);
        return last?.type === "assistant.message" ? last : null;
      });
      const tools = (await agent.rendered()).tools.map((t) => t.name);
      expect(tools).toEqual(
        expect.arrayContaining(["bash", "cd", "read_file", "write_file", "list_files"]),
      );
    } finally {
      await agent.dispose();
    }
  });
});
