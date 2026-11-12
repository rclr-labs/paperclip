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

interface RunsClient {
  listEvents(runId: string, companyId: string, options?: { afterSeq?: number; limit?: number }): Promise<RunEvent[]>;
}

export function heartbeatTierAvailability(ctx: PluginContext): { available: true } | { available: false; reason: string } {
  const agents = ctx.agents as unknown as Partial<CloneCapableAgents>;
  const runs = (ctx as unknown as { runs?: Partial<RunsClient> }).runs;
  if (typeof agents.clone !== "function" || typeof runs?.listEvents !== "function") {
    return { available: false, reason: "This Paperclip host does not expose agents.clone / runs.events.read to plugins yet." };
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

/** The adapter forwards the CLI's stream-json on stdout; rebuild it from the run events. */
export function traceFromRunEvents(events: readonly RunEvent[], outcome: RunOutcome, runId: string): EvalTrace {
  const stdout = events
    .filter((e) => e.stream === "stdout" && typeof e.message === "string")
    .sort((a, b) => a.seq - b.seq)
    .map((e) => e.message as string)
    .join("\n");
  const base = traceFromClaudeStreamJson(stdout, outcome.status === "succeeded" ? 0 : 1);
  return {
    ...base,
    tier: "heartbeat",
    runRef: runId,
    exit: outcome.status === "succeeded" ? base.exit : { ok: false, error: outcome.error ?? `run ${outcome.status}` },
  };
}

async function readAllEvents(runs: RunsClient, runId: string, companyId: string): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = await runs.listEvents(runId, companyId, { afterSeq, limit: 1000 });
    out.push(...page);
    if (page.length < 1000) return out;
    afterSeq = page[page.length - 1]!.seq;
  }
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
    const events = await readAllEvents(runs, runId, input.targetCompanyId);
    return traceFromRunEvents(events, outcome, runId);
  };
}
