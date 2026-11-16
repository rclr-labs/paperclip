import {
  createAnthropicJudge,
  DEFAULT_JUDGE_MODEL,
  runHeadless,
  runScenario,
  type EvalScenario,
  type ExecuteAttempt,
  type JudgeAttempt,
} from "@paperclipai/agent-evals-core";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { AwaitingApprovalError, createEvalAgents, type EvalAgents } from "./eval-agents.js";
import { createHeartbeatJudge } from "./heartbeat-judge.js";
import { createHeartbeatExecutor, heartbeatTierAvailability, type WaitForIssueRun } from "./heartbeat-tier.js";
import { EVALS_PROJECT_KEY } from "./manifest.js";
import { loadInstanceAgentBundle } from "./instance-bundle.js";
import { loadScenarioCatalog } from "./scenarios.js";
import type { EvalRunRow, EvalStore } from "./store.js";

export interface PluginEvalConfig {
  headlessEnabled?: boolean;
  judgeModel?: string;
  judgeApiKey?: unknown;
  maxDollarsPerRun?: number;
}

export async function buildJudge(ctx: PluginContext, config: PluginEvalConfig, companyId: string): Promise<JudgeAttempt | undefined> {
  if (!config.judgeApiKey) return undefined;
  const apiKey = await ctx.secrets.resolve(config.judgeApiKey as Parameters<PluginContext["secrets"]["resolve"]>[0], {
    companyId,
    configPath: "judgeApiKey",
  });
  return createAnthropicJudge({
    apiKey,
    model: config.judgeModel || DEFAULT_JUDGE_MODEL,
    // Route judge traffic through the host's outbound HTTP client (capability http.outbound).
    fetch: ((url: string | URL | Request, init?: RequestInit) => ctx.http.fetch(String(url instanceof Request ? url.url : url), init)) as typeof globalThis.fetch,
    knownSecrets: [apiKey],
  });
}

/** Execute one claimed run end to end; never throws (failures are recorded on the run). */
export async function executeRun(ctx: PluginContext, store: EvalStore, waitForIssueRun: WaitForIssueRun, run: EvalRunRow, bundledDir?: string): Promise<void> {
  const config = (await ctx.config.get(run.company_id)) as PluginEvalConfig;
  let spent = 0;
  let evalAgents: EvalAgents | undefined;
  try {
    const maxDollars = config.maxDollarsPerRun ?? 5;
    const { scenarios } = await loadScenarioCatalog(store, run.company_id, bundledDir);
    const selected = scenarios.filter((s) => run.scenario_ids.includes(s.scenario.id)).map((s) => s.scenario);
    const missing = run.scenario_ids.filter((id) => !selected.some((s) => s.id === id));
    if (selected.length === 0) throw new Error(`no matching scenarios (requested: ${run.scenario_ids.join(", ")})`);
    if (missing.length > 0) ctx.logger.warn("agent-evals: scenarios not found", { runId: run.id, missing });

    const bundle = await loadInstanceAgentBundle(ctx, run.agent_id, run.company_id);
    let judge = await buildJudge(ctx, config, run.company_id);

    let execute: ExecuteAttempt;
    if (run.tier === "headless") {
      if (!config.headlessEnabled) throw new Error("headless tier is disabled in the plugin settings");
      execute = async (arm, scenario) => runHeadless(arm.bundle, { prompt: scenario.prompt, maxTurns: scenario.max_turns });
    } else {
      const availability = heartbeatTierAvailability(ctx);
      if (!availability.available) throw new Error(availability.reason);
      const project = await ctx.projects.managed.reconcile(EVALS_PROJECT_KEY, run.company_id);
      if (!project.projectId) throw new Error("could not create the Evals project for eval issues");
      const source = await ctx.agents.get(run.agent_id, run.company_id);
      if (!source) throw new Error(`agent ${run.agent_id} not found in company ${run.company_id}`);
      evalAgents = createEvalAgents({ ctx, registry: store.evalAgents, companyId: run.company_id });
      const heartbeatScenarios = selected.filter((s) => s.tiers.includes("heartbeat"));
      const twins = await resolveEvalAgents(evalAgents, run.agent_id, source.name, bundle, heartbeatScenarios);
      const issueInput = { ctx, waitForIssueRun, companyId: run.company_id, projectId: project.projectId };
      execute = createHeartbeatExecutor({
        ...issueInput,
        agentFor: async (arm, scenario) => {
          if (arm.id === "with") return run.agent_id;
          const twin = twins.ablated.get(scenario.id);
          if (!twin) throw new Error(`no ablated twin resolved for scenario ${scenario.id}`);
          return twin;
        },
      });
      // Rubric grading runs on the company's own AI connection through the Eval Judge, never an API key.
      const judgeAgentId = twins.judge;
      judge = judgeAgentId
        ? createHeartbeatJudge({ ...issueInput, judgeAgentId: async () => judgeAgentId, onCost: (cost) => { spent += cost; } })
        : undefined;
    }

    for (const base of selected) {
      if (!base.tiers.includes(run.tier)) continue;
      const scenario = run.repeat_override ? { ...base, repeat: run.repeat_override } : base;
      const { report, attempts } = await runScenario({
        scenario,
        bundle,
        judge,
        execute: async (arm, s, repetition) => {
          if (spent >= maxDollars) throw new Error(`budget of $${maxDollars} for this eval run reached`);
          const trace = await execute(arm, s, repetition);
          spent += trace.usage.costUsd ?? 0;
          return trace;
        },
      });
      await store.saveResult(run.id, report, attempts);
    }
    await store.finishRun(run.id, "completed", spent, null);
    await ctx.activity.log({
      companyId: run.company_id,
      message: `Agent eval run completed: ${selected.length} scenario(s), ${run.tier} tier`,
      entityType: "agent",
      entityId: run.agent_id,
      metadata: { runId: run.id, spentUsd: spent },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.logger.error("agent-evals: run failed", { runId: run.id, error: message });
    await store.finishRun(run.id, "failed", spent, message);
  } finally {
    await evalAgents?.pauseResumed();
  }
}

/**
 * Resolve every eval agent a heartbeat run needs before any attempt runs, so a
 * company that requires board approval gets every pending hire in one run
 * (one approval round) instead of one per attempt.
 */
async function resolveEvalAgents(
  evalAgents: EvalAgents,
  agentId: string,
  agentName: string,
  bundle: Awaited<ReturnType<typeof loadInstanceAgentBundle>>,
  scenarios: readonly EvalScenario[],
): Promise<{ ablated: Map<string, string>; judge: string | null }> {
  const ablated = new Map<string, string>();
  let judge: string | null = null;
  const pending: string[] = [];
  const attempt = async (resolve: () => Promise<string>, onReady: (id: string) => void) => {
    try {
      onReady(await resolve());
    } catch (err) {
      if (err instanceof AwaitingApprovalError) pending.push(err.agentName);
      else throw err;
    }
  };
  for (const scenario of scenarios) {
    await attempt(() => evalAgents.ablatedTwin(agentId, agentName, bundle, scenario), (id) => ablated.set(scenario.id, id));
  }
  if (scenarios.some((s) => s.checks.rubric.length > 0)) {
    await attempt(() => evalAgents.judge(agentId), (id) => { judge = id; });
  }
  if (pending.length > 0) {
    const names = [...new Set(pending)].map((n) => `"${n}"`).join(", ");
    throw new Error(`awaiting board approval for the eval agent(s) ${names}: approve the hire(s) in Approvals, then queue the run again`);
  }
  return { ablated, judge };
}
