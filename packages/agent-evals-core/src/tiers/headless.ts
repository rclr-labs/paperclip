import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EvalBundle } from "../arms.js";
import { traceFromClaudeStreamJson, type EvalTrace } from "../trace.js";

/**
 * Headless tier: run the agent once through `claude -p`.
 *
 * The on-disk layout mirrors what the claude-local adapter builds for a real
 * heartbeat (`packages/adapters/claude-local/src/server/prompt-cache.ts`
 * `prepareClaudePromptBundle` + the args in `execute.ts` `buildClaudeArgs`):
 *
 *   <bundleDir>/agent-instructions.md      → --append-system-prompt-file
 *   <bundleDir>/.claude/skills/<slug>/...  → --add-dir <bundleDir>
 *
 * It is mirrored rather than imported so this package stays free of adapter
 * and instance-root dependencies and can ship inside the plugin bundle. If the
 * adapter layout changes, update `materializeBundle` and its test together.
 */

/** Same suffix the adapter appends to the instructions file. */
export const ADAPTER_INSTRUCTIONS_SUFFIX =
  "\nUse the agent instruction file location supplied in the current run prompt to resolve relative file references.";

export interface HeadlessRunOptions {
  readonly prompt: string;
  readonly maxTurns: number;
  readonly timeoutMs?: number;
  readonly command?: string;
  /** Tools the agent may use without prompting; everything else is denied (no permission bypass). */
  readonly allowedTools?: readonly string[];
  /**
   * Which settings Claude Code loads. Defaults to "project" so the operator's
   * own ~/.claude settings and memory do not leak into the agent under test.
   */
  readonly settingSources?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Keep the temp dirs for debugging. */
  readonly keepWorkDir?: boolean;
  /** Injected for tests. */
  readonly spawnFn?: typeof spawn;
}

export interface MaterializedBundle {
  readonly bundleDir: string;
  readonly instructionsFile: string | null;
}

function assertInside(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`bundle path escapes its root: ${relative}`);
  }
  return target;
}

export async function materializeBundle(bundle: EvalBundle, bundleDir: string): Promise<MaterializedBundle> {
  const skillsHome = path.join(bundleDir, ".claude", "skills");
  await fs.mkdir(skillsHome, { recursive: true });
  for (const [slug, files] of Object.entries(bundle.skills)) {
    const skillDir = assertInside(skillsHome, slug);
    for (const [rel, content] of Object.entries(files)) {
      const target = assertInside(skillDir, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    }
  }
  if (!bundle.instructions) return { bundleDir, instructionsFile: null };

  // Sibling instruction files (HEARTBEAT.md, TOOLS.md, ...) sit next to the entry file.
  const instructionsRoot = path.join(bundleDir, "instructions");
  for (const [rel, content] of Object.entries(bundle.instructions.files)) {
    const target = assertInside(instructionsRoot, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  const entry = bundle.instructions.files[bundle.instructions.entryFile];
  if (entry === undefined) throw new Error(`bundle ${bundle.id}: entry file ${bundle.instructions.entryFile} missing`);
  const instructionsFile = path.join(bundleDir, "agent-instructions.md");
  await fs.writeFile(instructionsFile, entry + ADAPTER_INSTRUCTIONS_SUFFIX, "utf8");
  return { bundleDir, instructionsFile };
}

export function buildHeadlessArgs(bundle: EvalBundle, materialized: MaterializedBundle, options: HeadlessRunOptions): string[] {
  const args = ["--print", "--output-format", "stream-json", "--verbose"];
  args.push("--setting-sources", options.settingSources ?? "project");
  if (bundle.model) args.push("--model", bundle.model);
  args.push("--max-turns", String(options.maxTurns));
  if (materialized.instructionsFile) args.push("--append-system-prompt-file", materialized.instructionsFile);
  args.push("--add-dir", materialized.bundleDir);
  if (options.allowedTools && options.allowedTools.length > 0) args.push("--allowedTools", options.allowedTools.join(","));
  return args;
}

export async function runHeadless(bundle: EvalBundle, options: HeadlessRunOptions): Promise<EvalTrace & { readonly raw: string }> {
  if (bundle.adapter !== "claude_local") {
    throw new Error(`headless tier only supports claude_local bundles (got ${bundle.adapter})`);
  }
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-eval-"));
  const bundleDir = path.join(workRoot, "bundle");
  const workspace = path.join(workRoot, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  try {
    const materialized = await materializeBundle(bundle, bundleDir);
    const args = buildHeadlessArgs(bundle, materialized, options);
    const spawnFn = options.spawnFn ?? spawn;
    const { stdout, exitCode, timedOut } = await new Promise<{ stdout: string; exitCode: number | null; timedOut: boolean }>(
      (resolve, reject) => {
        const child = spawnFn(options.command ?? "claude", args, {
          cwd: workspace,
          env: { ...process.env, ...options.env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs ?? 300_000);
        child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ stdout: out, exitCode: code, timedOut });
        });
        child.stdin?.end(options.prompt);
      },
    );
    const trace = traceFromClaudeStreamJson(stdout, timedOut ? null : exitCode);
    return {
      ...trace,
      exit: timedOut ? { ok: false, error: "timeout" } : trace.exit,
      runRef: options.keepWorkDir ? workRoot : undefined,
      raw: stdout,
    };
  } finally {
    if (!options.keepWorkDir) await fs.rm(workRoot, { recursive: true, force: true });
  }
}
