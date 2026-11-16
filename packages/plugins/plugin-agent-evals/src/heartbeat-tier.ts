import { traceFromClaudeStreamJson, type EvalArm, type EvalScenario, type EvalTrace } from "@paperclipai/agent-evals-core";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";

/**
 * Heartbeat tier: run the scenario through Paperclip itself, on the agent's
 * own company.
 *
 *   with arm:    an eval issue assigned to the agent itself
 *   ablated arm: the same issue shape assigned to the agent's ablated twin
 *                (see eval-agents.ts); an issue-level adapter override cannot
 *                blank instructions because the host re-materializes the
 *                agent's own bundle for every run
 *   → wait for the issue's agent.run.* event → read the run log
 *   → normalize into the same EvalTrace as headless → cancel the eval issue
 *
 * Both arms receive the prompt the same way, as an issue in the plugin's
 * managed "Evals" project, so the only difference between them is the
 * instruction under test.
 *
 * Needs `agents.clone` and `runs.events.read` (for `runs.readLog`). They are
 * read structurally so the plugin still loads on hosts without them;
 * `heartbeatTierAvailability` tells the UI why the tier is off.
 */

interface CloneCapableAgents {
  clone(agentId: string, input: unknown): Promise<unknown>;
}

interface RunEvent {
  seq: number;
  eventType: string;
  stream: "system" | "stdout" | "stderr" | null;
  message: string | null;
  payload: Record<string, unknown> | null;
}

interface RunLogPage {
  content: string;
  nextOffset?: number;
}

interface RunsClient {
  listEvents(runId: string, companyId: string, options?: { afterSeq?: number; limit?: number }): Promise<RunEvent[]>;
  readLog(runId: string, companyId: string, options?: { offset?: number; limitBytes?: number }): Promise<RunLogPage>;
}

export function heartbeatTierAvailability(ctx: PluginContext): { available: true } | { available: false; reason: string } {
  const agents = ctx.agents as unknown as Partial<CloneCapableAgents>;
  const runs = (ctx as unknown as { runs?: Partial<RunsClient> }).runs;
  if (typeof agents.clone !== "function" || typeof runs?.readLog !== "function") {
    return { available: false, reason: "This Paperclip host does not expose agents.clone / runs.readLog to plugins yet." };
  }
  return { available: true };
}

type RunOutcome = { status: "succeeded" | "failed" | "cancelled"; error: string | null };
export type IssueRunOutcome = RunOutcome & { runId: string | null };

/**
 * Resolves the first terminal run of an eval issue from agent.run.* events.
 * Register once in setup(); a run that finishes before the wait begins is kept.
 */
export function createRunWaiter(ctx: Pick<PluginContext, "events">) {
  const pending = new Map<string, (outcome: IssueRunOutcome) => void>();
  const settled = new Map<string, IssueRunOutcome>();
  const handle = (status: RunOutcome["status"]) => async (event: PluginEvent) => {
    const payload = (event.payload ?? {}) as { runId?: string; issueId?: string | null; error?: string | null };
    const issueId = payload.issueId;
    if (!issueId) return;
    const outcome: IssueRunOutcome = { status, error: payload.error ?? null, runId: payload.runId ?? event.entityId ?? null };
    const resolve = pending.get(issueId);
    if (resolve) {
      pending.delete(issueId);
      resolve(outcome);
    } else if (!settled.has(issueId)) {
      settled.set(issueId, outcome);
    }
  };
  ctx.events.on("agent.run.finished", handle("succeeded"));
  ctx.events.on("agent.run.failed", handle("failed"));
  ctx.events.on("agent.run.cancelled", handle("cancelled"));

  return function waitForIssueRun(issueId: string, timeoutMs: number): Promise<IssueRunOutcome> {
    const early = settled.get(issueId);
    if (early) {
      settled.delete(issueId);
      return Promise.resolve(early);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(issueId);
        resolve({ status: "failed", error: `timed out after ${Math.round(timeoutMs / 1000)}s waiting for a run of eval issue ${issueId}`, runId: null });
      }, timeoutMs);
      pending.set(issueId, (o) => {
        clearTimeout(timer);
        resolve(o);
      });
    });
  };
}

export type WaitForIssueRun = ReturnType<typeof createRunWaiter>;

/** Concatenate the stdout chunks of a run log (NDJSON records `{ ts, stream, chunk, seq? }`) in order. */
export function stdoutFromRunLog(log: string): string {
  const records: Array<{ chunk: string; seq: number; index: number }> = [];
  const seen = new Set<number>();
  for (const [index, line] of log.split("\n").entries()) {
    if (!line.trim()) continue;
    let record: { stream?: unknown; chunk?: unknown; seq?: unknown };
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a torn trailing record while the log is still being written
    }
    if (record.stream !== "stdout" || typeof record.chunk !== "string") continue;
    const seq = typeof record.seq === "number" ? record.seq : Number.NaN;
    if (Number.isFinite(seq)) {
      if (seen.has(seq)) continue; // readers may see a record twice across recovery
      seen.add(seq);
    }
    records.push({ chunk: record.chunk, seq, index });
  }
  const ordered = records.every((r) => Number.isFinite(r.seq))
    ? records.sort((a, b) => a.seq - b.seq)
    : records;
  return ordered.map((r) => r.chunk).join("");
}

function traceFromStdout(stdout: string, outcome: RunOutcome, runId: string): EvalTrace {
  const base = traceFromClaudeStreamJson(stdout, outcome.status === "succeeded" ? 0 : 1);
  return {
    ...base,
    tier: "heartbeat",
    runRef: runId,
    exit: outcome.status === "succeeded" ? base.exit : { ok: false, error: outcome.error ?? `run ${outcome.status}` },
  };
}

/**
 * The host keeps adapter stdout in the run log, chunked at arbitrary byte
 * boundaries; rebuild the CLI's stream-json from it.
 */
export function traceFromRunLog(log: string, outcome: RunOutcome, runId: string): EvalTrace {
  return traceFromStdout(stdoutFromRunLog(log), outcome, runId);
}

/** Legacy path for hosts that mirror stdout lines into run events. */
export function traceFromRunEvents(events: readonly RunEvent[], outcome: RunOutcome, runId: string): EvalTrace {
  const stdout = events
    .filter((e) => e.stream === "stdout" && typeof e.message === "string")
    .sort((a, b) => a.seq - b.seq)
    .map((e) => e.message as string)
    .join("\n");
  return traceFromStdout(stdout, outcome, runId);
}

const MAX_RUN_LOG_PAGES = 200;

export async function readWholeRunLog(runs: Pick<RunsClient, "readLog">, runId: string, companyId: string): Promise<string> {
  let content = "";
  let offset = 0;
  for (let page = 0; page < MAX_RUN_LOG_PAGES; page++) {
    const result = await runs.readLog(runId, companyId, { offset });
    content += result.content;
    if (typeof result.nextOffset !== "number" || result.nextOffset <= offset) return content;
    offset = result.nextOffset;
  }
  throw new Error(`run log for ${runId} exceeded ${MAX_RUN_LOG_PAGES} pages`);
}

export const EVAL_ISSUE_ORIGIN = "plugin:paperclipai.plugin-agent-evals" as const;

export interface HeartbeatTierInput {
  readonly ctx: PluginContext;
  readonly waitForIssueRun: WaitForIssueRun;
  readonly companyId: string;
  /** The plugin-managed "Evals" project that holds every eval issue. */
  readonly projectId: string;
  /** The agent that runs `arm` of `scenario`: the agent itself for `with`, its ablated twin otherwise. */
  readonly agentFor: (arm: EvalArm, scenario: EvalScenario) => Promise<string>;
  readonly runTimeoutMs?: number;
}

function evalIssueDescription(scenario: EvalScenario, arm: EvalArm): string {
  return [
    scenario.prompt.trim(),
    "",
    "---",
    `Agent-evals scenario \`${scenario.id}\`, arm \`${arm.id}\`. This is an evaluation, not real work: answer in this issue only.`,
  ].join("\n");
}

export interface IssueRunInput {
  readonly ctx: PluginContext;
  readonly waitForIssueRun: WaitForIssueRun;
  readonly companyId: string;
  readonly projectId: string;
  readonly runTimeoutMs?: number;
}

/**
 * Deliver a prompt as an eval issue assigned to `agentId`, wait for its run,
 * rebuild the trace from the run log, and cancel the issue so the agent never
 * keeps working it on later heartbeats.
 */
export async function runEvalIssue(input: IssueRunInput, agentId: string, title: string, description: string, originId: string): Promise<EvalTrace> {
  const runs = (input.ctx as unknown as { runs: RunsClient }).runs;
  const issue = await input.ctx.issues.create({
    companyId: input.companyId,
    projectId: input.projectId,
    title,
    description,
    status: "todo",
    assigneeAgentId: agentId,
    originKind: EVAL_ISSUE_ORIGIN,
    originId,
  });
  try {
    const outcome = await input.waitForIssueRun(issue.id, input.runTimeoutMs ?? 15 * 60_000);
    if (!outcome.runId) return traceFromStdout("", outcome, issue.id);
    const log = await readWholeRunLog(runs, outcome.runId, input.companyId);
    return traceFromRunLog(log, outcome, outcome.runId);
  } finally {
    await input.ctx.issues.update(issue.id, { status: "cancelled" }, input.companyId);
  }
}

export function createHeartbeatExecutor(input: HeartbeatTierInput) {
  return async (arm: EvalArm, scenario: EvalScenario): Promise<EvalTrace> => {
    const agentId = await input.agentFor(arm, scenario);
    return runEvalIssue(input, agentId, `eval · ${scenario.id} · ${arm.id}`, evalIssueDescription(scenario, arm), scenario.id);
  };
}
