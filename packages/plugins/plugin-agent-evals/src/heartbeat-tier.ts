import { traceFromClaudeStreamJson, type EvalArm, type EvalScenario, type EvalTrace } from "@paperclipai/agent-evals-core";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";

/**
 * Heartbeat tier: run the scenario through Paperclip itself.
 *
 *   clone agent into the target company (ablated arm: instructions overridden)
 *   → invoke the clone with the scenario prompt → wait for agent.run.finished
 *   → read the run's events → normalize into the same EvalTrace as headless
 *
 * Needs the SDK extension capabilities `agents.clone` and `runs.events.read`.
 * They are read structurally so the plugin still loads on hosts without them;
 * `heartbeatTierAvailability` tells the UI why the tier is off.
 */

interface CloneCapableAgents {
  clone(agentId: string, input: {
    sourceCompanyId: string;
    targetCompanyId: string;
    name?: string;
    instructionsOverride?: { entryFile: string; content: string } | { files: Record<string, string>; entryFile?: string };
  }): Promise<{ agent: { id: string }; requiresApproval: boolean; droppedConfig: string[] }>;
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

/** Resolves invoked runs from agent.run.* events. Register once in setup(). */
export function createRunWaiter(ctx: Pick<PluginContext, "events">) {
  const pending = new Map<string, (outcome: RunOutcome) => void>();
  const settled = new Map<string, RunOutcome>();
  const handle = (status: RunOutcome["status"]) => async (event: PluginEvent) => {
    const payload = (event.payload ?? {}) as { runId?: string; error?: string | null };
    const runId = payload.runId ?? event.entityId;
    if (!runId) return;
    const outcome = { status, error: payload.error ?? null };
    const resolve = pending.get(runId);
    if (resolve) {
      pending.delete(runId);
      resolve(outcome);
    } else {
      settled.set(runId, outcome); // finished before we started waiting
    }
  };
  ctx.events.on("agent.run.finished", handle("succeeded"));
  ctx.events.on("agent.run.failed", handle("failed"));
  ctx.events.on("agent.run.cancelled", handle("cancelled"));

  return function waitForRun(runId: string, timeoutMs: number): Promise<RunOutcome> {
    const early = settled.get(runId);
    if (early) {
      settled.delete(runId);
      return Promise.resolve(early);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(runId);
        resolve({ status: "failed", error: `timed out after ${Math.round(timeoutMs / 1000)}s waiting for run ${runId}` });
      }, timeoutMs);
      pending.set(runId, (o) => {
        clearTimeout(timer);
        resolve(o);
      });
    });
  };
}

export type WaitForRun = ReturnType<typeof createRunWaiter>;

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

export interface HeartbeatTierInput {
  readonly ctx: PluginContext;
  readonly waitForRun: WaitForRun;
  readonly sourceAgentId: string;
  readonly sourceCompanyId: string;
  readonly targetCompanyId: string;
  readonly runTimeoutMs?: number;
}

export function createHeartbeatExecutor(input: HeartbeatTierInput) {
  const agents = input.ctx.agents as unknown as CloneCapableAgents & PluginContext["agents"];
  const runs = (input.ctx as unknown as { runs: RunsClient }).runs;
  const clones = new Map<string, string>(); // arm id → clone agent id (one clone per arm per run)

  async function cloneFor(arm: EvalArm, scenario: EvalScenario): Promise<string> {
    const existing = clones.get(`${scenario.id}:${arm.id}`);
    if (existing) return existing;
    const ablations = Array.isArray(scenario.ablate) ? scenario.ablate : [scenario.ablate];
    if (arm.id === "ablated" && ablations.some((a) => a !== "instructions")) {
      throw new Error(`heartbeat tier can only ablate instructions for now (scenario asks for ${ablations.join(" + ")})`);
    }
    const instructionsOverride =
      arm.id === "ablated" ? { entryFile: arm.bundle.instructions?.entryFile ?? "AGENTS.md", content: "" } : undefined;
    const result = await agents.clone(input.sourceAgentId, {
      sourceCompanyId: input.sourceCompanyId,
      targetCompanyId: input.targetCompanyId,
      name: `eval · ${scenario.id} · ${arm.id}`,
      instructionsOverride,
    });
    if (result.requiresApproval) throw new Error("the eval company requires board approval for new agents; approve the clone or relax the policy for the eval company");
    clones.set(`${scenario.id}:${arm.id}`, result.agent.id);
    return result.agent.id;
  }

  return async (arm: EvalArm, scenario: EvalScenario): Promise<EvalTrace> => {
    const cloneId = await cloneFor(arm, scenario);
    const { runId } = await agents.invoke(cloneId, input.targetCompanyId, {
      prompt: scenario.prompt,
      reason: `agent-evals ${scenario.id} (${arm.id})`,
    });
    const outcome = await input.waitForRun(runId, input.runTimeoutMs ?? 15 * 60_000);
    const log = await readWholeRunLog(runs, runId, input.targetCompanyId);
    return traceFromRunLog(log, outcome, runId);
  };
}
