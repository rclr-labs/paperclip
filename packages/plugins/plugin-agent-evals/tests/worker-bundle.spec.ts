import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Vitest runs the TypeScript sources; the host runs the esbuild bundle. A CJS
 * dependency bundled into the ESM worker (yaml, via agent-evals-core) only
 * fails there, so start the built worker the way the host does.
 */
describe("built worker bundle", () => {
  beforeAll(() => {
    execFileSync(process.execPath, ["./esbuild.config.mjs"], { cwd: pkg, stdio: "pipe" });
  }, 120_000);

  it("starts as an ESM process without crashing on bundled CommonJS dependencies", async () => {
    const child = spawn(process.execPath, ["dist/worker.js"], { cwd: pkg, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const outcome = await Promise.race([exited, new Promise<"alive">((resolve) => setTimeout(() => resolve("alive"), 3000))]);
    child.kill();
    expect(stderr).not.toMatch(/Dynamic require|Error:/);
    expect(outcome).toBe("alive"); // waiting for the host's RPC on stdin
  }, 30_000);
});
