import { randomUUID } from "node:crypto";
import { parseScenario, ScenarioParseError } from "@paperclipai/agent-evals-core";
import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { executeRun, type PluginEvalConfig } from "./execute-run.js";
import { createRunWaiter, heartbeatTierAvailability, type WaitForRun } from "./heartbeat-tier.js";
import { JOB_NIGHTLY, JOB_RUN_QUEUED } from "./manifest.js";
import { loadScenarioCatalog } from "./scenarios.js";
import { createStore, type EvalStore, type EvalTier } from "./store.js";

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required`);
  return value.trim();
}

export interface WorkerDeps {
  /** Override for tests; defaults to the plugin's bundled `scenarios/`. */
  bundledScenariosDir?: string;
}

export function registerAgentEvals(ctx: PluginContext, deps: WorkerDeps = {}): { store: EvalStore; waitForRun: WaitForRun } {
  const store = createStore(ctx);
  const waitForRun = createRunWaiter(ctx);
  let draining = false;

  async function drainQueue(): Promise<number> {
    if (draining) return 0; // the queue job fires every 5 minutes; runs can take longer
    draining = true;
    let executed = 0;
    try {
      for (const run of await store.listQueuedRuns()) {
        if (!(await store.claimRun(run.id))) continue;
        await executeRun(ctx, store, waitForRun, run, deps.bundledScenariosDir);
        executed++;
      }
    } finally {
      draining = false;
    }
    return executed;
  }

  ctx.data.register("overview", async (params) => {
    const companyId = requireString(params.companyId, "companyId");
    const config = (await ctx.config.get(companyId)) as PluginEvalConfig;
    const { scenarios, invalid } = await loadScenarioCatalog(store, companyId, deps.bundledScenariosDir);
    const heartbeat = heartbeatTierAvailability(ctx);
    return {
      scenarios: scenarios.map((s) => ({
        id: s.scenario.id,
        description: s.scenario.description ?? null,
        source: s.source,
        target: s.scenario.target,
        tiers: s.scenario.tiers,
        ablate: s.scenario.ablate,
        repeat: s.scenario.repeat,
        pressures: s.scenario.pressures,
      })),
      invalidScenarios: invalid,
      tiers: {
        headless: config.headlessEnabled ? { available: true } : { available: false, reason: "Disabled in plugin settings (needs the Claude CLI on the worker host)." },
        heartbeat: heartbeat.available && !config.evalCompanyId ? { available: false, reason: "Set an eval company in the plugin settings." } : heartbeat,
      },
      evalCompanyId: config.evalCompanyId ?? null,
      allowRealCompany: config.allowRealCompany === true,
      judge: config.judgeApiKey ? { enabled: true, model: config.judgeModel ?? "claude-opus-5-5" } : { enabled: false },
    };
  });

  ctx.data.register("agents", async (params) => {
    const companyId = requireString(params.companyId, "companyId");
    const agents = await ctx.agents.list({ companyId });
    return { agents: agents.map((a) => ({ id: a.id, name: a.name, role: a.role, title: a.title ?? null })) };
  });

  ctx.data.register("runs", async (params) => {
    const companyId = requireString(params.companyId, "companyId");
    const agentId = typeof params.agentId === "string" && params.agentId ? params.agentId : undefined;
    return { runs: await store.listRuns(companyId, agentId) };
  });

  ctx.data.register("run", async (params) => {
    const companyId = requireString(params.companyId, "companyId");
    const run = await store.getRun(companyId, requireString(params.runId, "runId"));
    if (!run) return { run: null, results: [] };
    return { run, results: await store.listResults(run.id) };
  });

  ctx.actions.register("import-scenario", async (params) => {
    const companyId = requireString(params.companyId, "companyId");
    const yaml = requireString(params.yaml, "yaml");
    try {
      const scenario = parseScenario(yaml, "imported");
      await store.upsertScenario(companyId, scenario.id, yaml);
      return { ok: true, scenarioId: scenario.id };
    } catch (err) {
      if (err instanceof ScenarioParseError) return { ok: false, error: err.message, issues: err.issues };
      throw err;
    }
  });

  ctx.actions.register("queue-run", async (params, context) => {
    const companyId = requireString(params.companyId, "companyId");
    const agentId = requireString(params.agentId, "agentId");
    const tier = requireString(params.tier, "tier") as EvalTier;
    if (tier !== "headless" && tier !== "heartbeat") throw new Error(`unknown tier ${tier}`);
    const scenarioIds = Array.isArray(params.scenarioIds) ? params.scenarioIds.filter((s): s is string => typeof s === "string") : [];
    if (scenarioIds.length === 0) throw new Error("pick at least one scenario");
    const config = (await ctx.config.get(companyId)) as PluginEvalConfig;

    // Default: the dedicated eval company. The agent's own company only with the setting on AND an explicit confirmation.
    const useRealCompany = params.useRealCompany === true;
    if (useRealCompany && !config.allowRealCompany) throw new Error("running in the agent's own company is disabled in the plugin settings");
    if (useRealCompany && params.confirmRealCompany !== true) throw new Error("confirm that this run creates issues and spends budget in the agent's own company");
    const targetCompanyId = tier === "headless" ? companyId : useRealCompany ? companyId : requireString(config.evalCompanyId, "eval company (plugin settings)");

    const agent = await ctx.agents.get(agentId, companyId);
    if (!agent) throw new Error("agent not found in this company");
    const repeat = typeof params.repeat === "number" && params.repeat >= 1 && params.repeat <= 20 ? Math.floor(params.repeat) : null;
    const id = randomUUID();
    await store.queueRun({
      id,
      company_id: companyId,
      agent_id: agentId,
      tier,
      target_company_id: targetCompanyId,
      scenario_ids: scenarioIds,
      repeat_override: repeat,
      requested_by: (context as { actor?: { id?: string } } | undefined)?.actor?.id ?? null,
    });
    await ctx.activity.log({
      companyId,
      message: `Queued agent eval run (${scenarioIds.length} scenario(s), ${tier} tier)`,
      entityType: "agent",
      entityId: agentId,
      metadata: { runId: id, targetCompanyId },
    });
    return { ok: true, runId: id };
  });

  ctx.jobs.register(JOB_RUN_QUEUED, async () => {
    await drainQueue();
  });

  ctx.jobs.register(JOB_NIGHTLY, async () => {
    for (const last of await store.latestRunPerAgent()) {
      await store.queueRun({
        id: randomUUID(),
        company_id: last.company_id,
        agent_id: last.agent_id,
        tier: last.tier,
        target_company_id: last.target_company_id,
        scenario_ids: last.scenario_ids,
        repeat_override: last.repeat_override,
        requested_by: "nightly",
      });
    }
    await drainQueue();
  });

  return { store, waitForRun };
}

const plugin = definePlugin({
  async setup(ctx) {
    registerAgentEvals(ctx);
  },
  async onHealth() {
    return { status: "ok", message: "Agent Evals ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
