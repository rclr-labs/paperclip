#!/usr/bin/env node
/**
 * Local instruction-eval loop (headless tier).
 *
 *   pnpm evals:agents [--scenario <file-or-dir>] [--repeat N] [--model M] [--max-dollars D] [--judge [--judge-model M]] [--keep]
 *
 * Rubric criteria are only graded with --judge (opt-in: transcripts are sent to
 * the Anthropic API for grading). Without it, only hard checks decide.
 *
 * Scenarios default to `evals/agents/scenarios`. Results go to
 * `evals/agents/results/<timestamp>/` (gitignored).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import type { EvalBundle } from "./arms.js";
import { loadAgentBundleFromDir, loadSkillBundle } from "./bundle-loader.js";
import { createAnthropicJudge, createClaudeCliJudge, DEFAULT_JUDGE_MODEL } from "./judge.js";
import { renderMarkdownReport, type ScenarioReport } from "./report.js";
import { runScenario } from "./run.js";
import { parseScenario, type EvalScenario } from "./scenario.js";
import { runHeadless } from "./tiers/headless.js";

const repoRoot = path.resolve(process.env.INIT_CWD ?? process.cwd());
const skillRoots = [path.join(repoRoot, "packages/skills-catalog/catalog/bundled"), path.join(repoRoot, "skills")];

async function collectScenarioFiles(target: string): Promise<string[]> {
  const stat = await fs.stat(target);
  if (stat.isFile()) return [target];
  const out: string[] = [];
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...(await collectScenarioFiles(full)));
    else if (/\.ya?ml$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

async function resolveBundle(scenario: EvalScenario, model: string | undefined): Promise<EvalBundle> {
  const [source, ...rest] = scenario.target.ref.split(":");
  const ref = rest.join(":");
  if (scenario.target.kind === "skill") {
    return loadSkillBundle({ id: scenario.target.ref, slug: path.basename(ref), skillRoots, model });
  }
  const agentDir =
    // teams-catalog:<category>/<team>/<role> → catalog/bundled/<category>/<team>/agents/<role>
    source === "teams-catalog" ? path.join(repoRoot, "packages/teams-catalog/catalog/bundled", path.dirname(ref), "agents", path.basename(ref))
    : source === "dir" ? path.resolve(repoRoot, ref)
    : null;
  if (!agentDir) throw new Error(`${scenario.id}: source "${source}" is not available in the local CLI (use the agent-evals plugin for instance agents)`);
  return loadAgentBundleFromDir({ id: scenario.target.ref, agentDir, skillRoots, model });
}

async function main() {
  const { values } = parseArgs({
    options: {
      scenario: { type: "string", default: path.join(repoRoot, "evals/agents/scenarios") },
      repeat: { type: "string" },
      model: { type: "string" },
      "max-dollars": { type: "string", default: "5" },
      keep: { type: "boolean", default: false },
      judge: { type: "boolean", default: false },
      "judge-model": { type: "string", default: DEFAULT_JUDGE_MODEL },
      "judge-backend": { type: "string", default: "cli" },
    },
  });
  const maxDollars = Number(values["max-dollars"]);
  const files = await collectScenarioFiles(path.resolve(repoRoot, values.scenario!));
  const scenarios = await Promise.all(
    files.map(async (f) => {
      const s = parseScenario(await fs.readFile(f, "utf8"), path.relative(repoRoot, f));
      return values.repeat ? { ...s, repeat: Number(values.repeat) } : s;
    }),
  );
  const outDir = path.join(repoRoot, "evals/agents/results", new Date().toISOString().replace(/[:.]/g, "-"));
  await fs.mkdir(path.join(outDir, "transcripts"), { recursive: true });

  const reports: ScenarioReport[] = [];
  let spent = 0;
  const judgeTokens = { inputTokens: 0, outputTokens: 0 };
  const onJudgeUsage = (u: { inputTokens: number; outputTokens: number; costUsd?: number | null }) => {
    judgeTokens.inputTokens += u.inputTokens;
    judgeTokens.outputTokens += u.outputTokens;
    spent += u.costUsd ?? 0;
  };
  // "cli" reuses the claude CLI login; "api" needs ANTHROPIC_API_KEY (and is what the plugin uses).
  const judge = !values.judge
    ? undefined
    : values["judge-backend"] === "api"
      ? createAnthropicJudge({ model: values["judge-model"], onUsage: onJudgeUsage })
      : createClaudeCliJudge({ model: values["judge-model"], onUsage: onJudgeUsage });
  for (const scenario of scenarios) {
    if (!scenario.tiers.includes("headless")) continue;
    const bundle = await resolveBundle(scenario, values.model);
    process.stderr.write(`▶ ${scenario.id} (${scenario.repeat}× with/ablated)\n`);
    const { report, attempts } = await runScenario({
      scenario,
      bundle,
      judge,
      execute: async (arm, s, repetition) => {
        if (spent >= maxDollars) throw new Error(`budget of $${maxDollars} reached`);
        const trace = await runHeadless(arm.bundle, { prompt: s.prompt, maxTurns: s.max_turns, keepWorkDir: values.keep });
        spent += trace.usage.costUsd ?? 0;
        await fs.writeFile(path.join(outDir, "transcripts", `${s.id}.${arm.id}.${repetition}.ndjson`), trace.raw);
        return trace;
      },
      onAttempt: (a) => process.stderr.write(`  ${a.arm.padEnd(7)} #${a.repetition} ${a.error ? `ERROR ${a.error}` : a.passed ? "pass" : "FAIL"}\n`),
    });
    reports.push(report);
    await fs.writeFile(path.join(outDir, `${scenario.id}.attempts.json`), JSON.stringify(attempts, null, 2));
  }
  const markdown = renderMarkdownReport(reports);
  await fs.writeFile(path.join(outDir, "report.md"), markdown);
  const judgeSummary = judge ? { model: values["judge-model"], ...judgeTokens } : null;
  await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify({ reports, spentUsd: spent, judge: judgeSummary }, null, 2));
  const judgeLine = judgeSummary
    ? `, judge ${judgeSummary.model}: ${judgeSummary.inputTokens} in / ${judgeSummary.outputTokens} out tokens`
    : ", rubric not graded (pass --judge)";
  process.stdout.write(`${markdown}\nResults: ${path.relative(repoRoot, outDir)}  (total $${spent.toFixed(2)}, agent + judge${judgeLine})\n`);
  if (reports.some((r) => r.admission === "regressed")) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
