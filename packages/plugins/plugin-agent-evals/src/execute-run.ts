import {
  createAnthropicJudge,
  DEFAULT_JUDGE_MODEL,
  runHeadless,
  runScenario,
  type ExecuteAttempt,
  type JudgeAttempt,
} from "@paperclipai/agent-evals-core";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createHeartbeatExecutor, heartbeatTierAvailability, type WaitForRun } from "./heartbeat-tier.js";
import { loadInstanceAgentBundle } from "./instance-bundle.js";
import { loadScenarioCatalog } from "./scenarios.js";
import type { EvalRunRow, EvalStore } from "./store.js";

export interface PluginEvalConfig {
  evalCompanyId?: string;
  allowRealCompany?: boolean;
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
export async function executeRun(ctx: PluginContext, store: EvalStore, waitForRun: WaitForRun, run: EvalRunRow, bundledDir?: string): Promise<void> {
  const config = (await ctx.config.get(run.company_id)) as PluginEvalConfig;
  let spent = 0;
  try {
    const maxDollars = config.maxDollarsPerRun ?? 5;
    const { scenarios } = await loadScenarioCatalog(store, run.company_id, bundledDir);
    const selected = scenarios.filter((s) => run.scenario_ids.includes(s.scenario.id)).map((s) => s.scenario);
    const missing = run.scenario_ids.filter((id) => !selected.some((s) => s.id === id));
    if (selected.length === 0) throw new Error(`no matching scenarios (requested: ${run.scenario_ids.join(", ")})`);
    if (missing.length > 0) ctx.logger.warn("agent-evals: scenarios not found", { runId: run.id, missing });

    const bundle = await loadInstanceAgentBundle(ctx, run.agent_id, run.company_id);
    const judge = await buildJudge(ctx, config, run.company_id);

    let execute: ExecuteAttempt;
    if (run.tier === "headless") {
      if (!config.headlessEnabled) throw new Error("headless tier is disabled in the plugin settings");
      execute = async (arm, scenario) => runHeadless(arm.bundle, { prompt: scenario.prompt, maxTurns: scenario.max_turns });
    } else {
      const availability = heartbeatTierAvailability(ctx);
      if (!availability.available) throw new Error(availability.reason);
      if (run.target_company_id === run.company_id && !config.allowRealCompany) {
        throw new Error("running in the agent's own company is disabled; set an eval company or enable allowRealCompany");
      }
      execute = createHeartbeatExecutor({ ctx, waitForRun, sourceAgentId: run.agent_id, sourceCompanyId: run.company_id, targetCompanyId: run.target_company_id });
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
  }
}
