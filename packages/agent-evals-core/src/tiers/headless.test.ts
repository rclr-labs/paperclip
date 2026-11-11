import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { EvalBundle } from "../arms.js";
import { ADAPTER_INSTRUCTIONS_SUFFIX, buildHeadlessArgs, materializeBundle, runHeadless } from "./headless.js";

const bundle: EvalBundle = {
  id: "qa",
  adapter: "claude_local",
  model: "claude-sonnet-5-5",
  instructions: { entryFile: "AGENTS.md", files: { "AGENTS.md": "You are QA.", "HEARTBEAT.md": "hb" } },
  skills: { "qa-acceptance": { "SKILL.md": "---\nname: qa-acceptance\n---\nbody", "refs/a.md": "a" } },
};

describe("headless tier", () => {
  it("materializes the claude-local prompt-bundle layout", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aec-"));
    const m = await materializeBundle(bundle, dir);
    expect(await fs.readFile(m.instructionsFile!, "utf8")).toBe(`You are QA.${ADAPTER_INSTRUCTIONS_SUFFIX}`);
    expect(await fs.readFile(path.join(dir, ".claude/skills/qa-acceptance/refs/a.md"), "utf8")).toBe("a");
    expect(await fs.readFile(path.join(dir, "instructions/HEARTBEAT.md"), "utf8")).toBe("hb");
    expect(buildHeadlessArgs(bundle, m, { prompt: "p", maxTurns: 7 })).toEqual([
      "--print", "--output-format", "stream-json", "--verbose",
      "--setting-sources", "project",
      "--model", "claude-sonnet-5-5",
      "--max-turns", "7",
      "--append-system-prompt-file", m.instructionsFile,
      "--add-dir", dir,
    ]);
  });

  it("omits the instructions flag for the ablated arm and rejects path escapes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aec-"));
    const m = await materializeBundle({ ...bundle, instructions: null }, dir);
    expect(buildHeadlessArgs(bundle, m, { prompt: "p", maxTurns: 1 })).not.toContain("--append-system-prompt-file");
    await expect(materializeBundle({ ...bundle, skills: { x: { "../../evil": "x" } } }, dir)).rejects.toThrow(/escapes/);
  });

  it("feeds the prompt on stdin and normalizes the stream", async () => {
    let stdinText = "";
    let seenArgs: string[] = [];
    const fakeSpawn = ((_cmd: string, args: string[]) => {
      seenArgs = args;
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      child.stdin.on("data", (c: Buffer) => (stdinText += c.toString()));
      child.stdin.on("finish", () => {
        child.stdout.end('{"type":"result","subtype":"success","result":"done","usage":{"input_tokens":1,"output_tokens":2}}\n');
        setImmediate(() => child.emit("close", 0));
      });
      return child;
    }) as never;
    const trace = await runHeadless(bundle, { prompt: "Approve it now.", maxTurns: 3, spawnFn: fakeSpawn });
    expect(stdinText).toBe("Approve it now.");
    expect(seenArgs).toContain("--append-system-prompt-file");
    expect(trace).toMatchObject({ finalText: "done", exit: { ok: true } });
  });
});
