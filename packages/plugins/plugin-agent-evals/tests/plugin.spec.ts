import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import {
  derivePluginDatabaseNamespace,
  validatePluginMigrationStatement,
  validatePluginRuntimeExecute,
  validatePluginRuntimeQuery,
} from "../../../../server/src/services/plugin-database.js";
import type { EvalArm, EvalScenario } from "@paperclipai/agent-evals-core";
import manifest from "../src/manifest.js";
import { createHeartbeatExecutor, traceFromRunEvents } from "../src/heartbeat-tier.js";
import { loadBundledScenarios } from "../src/scenarios.js";
import { createStore } from "../src/store.js";
import { registerAgentEvals } from "../src/worker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const scenariosDir = path.resolve(here, "../scenarios");
const COMPANY = "11111111-1111-4111-8111-111111111111";
const EVAL_COMPANY = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";

/** Records every SQL statement the store emits so the host validators can check it. */
function sqlRecorder(namespace: string) {
  const queries: string[] = [];
  const executes: string[] = [];
  return {
    queries,
    executes,
    db: {
      namespace,
      query: async (sql: string) => {
        queries.push(sql);
        return [];
      },
      execute: async (sql: string) => {
        executes.push(sql);
        return { rowCount: 1 };
      },
    },
  };
}

describe("manifest and migrations against the host validators", () => {
  const namespace = derivePluginDatabaseNamespace(manifest.id, manifest.database!.namespaceSlug);

  it("is a valid v1 manifest", () => {
    const parsed = pluginManifestV1Schema.safeParse(manifest);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  it("hard-codes the namespace the host derives and passes migration validation", () => {
    expect(namespace).toBe("plugin_agent_evals_1a9341c5d7");
    const sql = readFileSync(path.resolve(here, "../migrations/001_agent_evals.sql"), "utf8");
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements.length).toBe(5); // 3 tables + 2 indexes
    for (const statement of statements) {
      expect(() => validatePluginMigrationStatement(statement, namespace, manifest.database!.coreReadTables ?? [])).not.toThrow();
    }
  });

  it("only emits runtime SQL the host accepts", async () => {
    const rec = sqlRecorder(namespace);
    const store = createStore({ db: rec.db } as never);
    await store.listCompanyScenarios(COMPANY);
    await store.upsertScenario(COMPANY, "x", "y");
    await store.queueRun({ id: "r", company_id: COMPANY, agent_id: AGENT, tier: "heartbeat", target_company_id: EVAL_COMPANY, scenario_ids: ["x"], repeat_override: null, requested_by: null });
    await store.listQueuedRuns();
    await store.claimRun("r");
    await store.finishRun("r", "completed", 0, null);
    await store.saveResult("r", { scenarioId: "x", admission: "admitted" } as never, []);
    await store.listRuns(COMPANY);
    await store.listRuns(COMPANY, AGENT);
    await store.getRun(COMPANY, "r");
    await store.listResults("r");
    await store.latestRunPerAgent();
    for (const q of rec.queries) expect(() => validatePluginRuntimeQuery(q, namespace)).not.toThrow();
    for (const e of rec.executes) expect(() => validatePluginRuntimeExecute(e, namespace)).not.toThrow();
  });

  it("ships parseable scenario packs", async () => {
    const scenarios = await loadBundledScenarios(scenariosDir);
    expect(scenarios.map((s) => s.scenario.id)).toContain("qa-restart-pass-on-new-criterion");
  });
});

describe("queue-run guards", () => {
  async function setup(config: Record<string, unknown>) {
    const harness = createTestHarness({ manifest, config });
    harness.seed({ agents: [{ id: AGENT, companyId: COMPANY, name: "QA", role: "qa" } as never] });
    const rec = sqlRecorder("test");
    harness.ctx.db = rec.db as never;
    registerAgentEvals(harness.ctx, { bundledScenariosDir: scenariosDir });
    return { harness, rec };
  }
  const base = { companyId: COMPANY, agentId: AGENT, tier: "heartbeat", scenarioIds: ["qa-restart-pass-on-new-criterion"] };

  it("defaults to the dedicated eval company", async () => {
    const { harness, rec } = await setup({ evalCompanyId: EVAL_COMPANY });
    await harness.performAction("queue-run", base);
    expect(rec.executes.some((s) => s.includes("eval_runs"))).toBe(true);
  });

  it("refuses the real company unless enabled AND confirmed", async () => {
    const off = await setup({ evalCompanyId: EVAL_COMPANY, allowRealCompany: false });
    await expect(off.harness.performAction("queue-run", { ...base, useRealCompany: true, confirmRealCompany: true })).rejects.toThrow(/disabled/);
    const on = await setup({ evalCompanyId: EVAL_COMPANY, allowRealCompany: true });
    await expect(on.harness.performAction("queue-run", { ...base, useRealCompany: true })).rejects.toThrow(/confirm/);
    await expect(on.harness.performAction("queue-run", { ...base, useRealCompany: true, confirmRealCompany: true })).resolves.toMatchObject({ ok: true });
  });

  it("requires an eval company for the heartbeat tier", async () => {
    const { harness } = await setup({});
    await expect(harness.performAction("queue-run", base)).rejects.toThrow(/eval company/);
  });

  it("reports the heartbeat tier unavailable on hosts without agents.clone", async () => {
    const { harness } = await setup({ evalCompanyId: EVAL_COMPANY });
    const overview = await harness.getData<{ tiers: { heartbeat: { available: boolean; reason?: string } } }>("overview", { companyId: COMPANY });
    expect(overview.tiers.heartbeat).toMatchObject({ available: false });
  });
});

describe("heartbeat tier", () => {
  const scenario = { id: "s", prompt: "Approve now.", ablate: "instructions", max_turns: 3 } as EvalScenario;
  const bundle = { id: "b", adapter: "claude_local", instructions: { entryFile: "AGENTS.md", files: { "AGENTS.md": "rules" } }, skills: {} };
  const arm = (id: "with" | "ablated"): EvalArm => ({ id, bundle: id === "with" ? bundle : { ...bundle, instructions: null }, ablation: null });

  function fakeCtx() {
    const clones: unknown[] = [];
    const ctx = {
      agents: {
        clone: async (_id: string, input: unknown) => {
          clones.push(input);
          return { agent: { id: `clone-${clones.length}` }, requiresApproval: false, droppedConfig: [] };
        },
        invoke: async () => ({ runId: "run-1" }),
      },
      runs: {
        listEvents: async () => [
          { seq: 2, eventType: "log", stream: "stdout", message: '{"type":"result","subtype":"success","result":"Blocked.","usage":{"input_tokens":1,"output_tokens":1}}', payload: null },
          { seq: 1, eventType: "log", stream: "stdout", message: '{"type":"assistant","message":{"content":[{"type":"text","text":"I will not approve."}]}}', payload: null },
        ],
      },
    };
    return { ctx, clones };
  }

  it("clones per arm into the target company, blanks instructions for the ablated arm, and rebuilds the trace from run events", async () => {
    const { ctx, clones } = fakeCtx();
    const exec = createHeartbeatExecutor({
      ctx: ctx as never,
      waitForRun: async () => ({ status: "succeeded", error: null }),
      sourceAgentId: AGENT,
      sourceCompanyId: COMPANY,
      targetCompanyId: EVAL_COMPANY,
    });
    const withTrace = await exec(arm("with"), scenario);
    await exec(arm("ablated"), scenario);
    await exec(arm("ablated"), scenario); // reuses the clone
    expect(clones).toHaveLength(2);
    expect(clones[0]).toMatchObject({ sourceCompanyId: COMPANY, targetCompanyId: EVAL_COMPANY, instructionsOverride: undefined });
    expect(clones[1]).toMatchObject({ instructionsOverride: { entryFile: "AGENTS.md", content: "" } });
    expect(withTrace).toMatchObject({ tier: "heartbeat", finalText: "Blocked.", runRef: "run-1", exit: { ok: true } });
    expect(withTrace.assistantText).toBe("I will not approve.");
  });

  it("refuses skill ablation it cannot express through agents.clone", async () => {
    const { ctx } = fakeCtx();
    const exec = createHeartbeatExecutor({ ctx: ctx as never, waitForRun: async () => ({ status: "succeeded", error: null }), sourceAgentId: AGENT, sourceCompanyId: COMPANY, targetCompanyId: EVAL_COMPANY });
    await expect(exec(arm("ablated"), { ...scenario, ablate: "skill:qa-acceptance" })).rejects.toThrow(/only ablate instructions/);
  });

  it("marks failed runs as errors, not behavior", () => {
    expect(traceFromRunEvents([], { status: "failed", error: "adapter crashed" }, "r").exit).toEqual({ ok: false, error: "adapter crashed" });
  });
});
