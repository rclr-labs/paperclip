import { randomUUID } from "node:crypto";
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
import { createHeartbeatExecutor, createRunWaiter, readWholeRunLog, traceFromRunEvents, traceFromRunLog } from "../src/heartbeat-tier.js";
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
  const params: unknown[][] = [];
  return {
    queries,
    executes,
    params,
    db: {
      namespace,
      query: async (sql: string): Promise<unknown[]> => {
        queries.push(sql);
        return [];
      },
      execute: async (sql: string, values: unknown[] = []) => {
        executes.push(sql);
        params.push(values);
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

  it.each([
    ["001_agent_evals.sql", 5], // 3 tables + 2 indexes
    ["002_eval_agents.sql", 2], // 1 table + 1 index
  ])("hard-codes the namespace the host derives and %s passes migration validation", (file, count) => {
    expect(namespace).toBe("plugin_agent_evals_1a9341c5d7");
    const sql = readFileSync(path.resolve(here, "../migrations", file), "utf8");
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements.length).toBe(count);
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
    await store.evalAgents.find(COMPANY, "ablated", "instructions", AGENT, "d");
    await store.evalAgents.find(COMPANY, "judge", "judge-v1", null, null);
    await store.evalAgents.save({ company_id: COMPANY, source_agent_id: AGENT, role: "judge", ablation: "judge-v1", source_digest: "judge-v1", eval_agent_id: AGENT, name: "n" });
    await store.evalAgents.remove(COMPANY, AGENT);
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

  it("queues a heartbeat run on the agent's own company once the spend is confirmed", async () => {
    const { harness, rec } = await setup({});
    await expect(harness.performAction("queue-run", base)).rejects.toThrow(/spends this agent's budget/);
    await expect(harness.performAction("queue-run", { ...base, confirmSpend: true })).resolves.toMatchObject({ ok: true });
    const insert = rec.executes.find((sql) => sql.includes("eval_runs"));
    expect(insert).toBeDefined();
  });

  it("refuses an agent outside the company", async () => {
    const { harness } = await setup({});
    await expect(harness.performAction("queue-run", { ...base, agentId: "55555555-5555-4555-8555-555555555555", confirmSpend: true })).rejects.toThrow(/agent not found/);
  });

  it("nightly regression re-queues only headless runs: a heartbeat run spends agent budgets and needs a person to confirm it", async () => {
    const { harness, rec } = await setup({});
    const last = (tier: string, agent: string) => ({
      id: randomUUID(), company_id: COMPANY, agent_id: agent, tier, target_company_id: COMPANY,
      scenario_ids: ["qa-restart-pass-on-new-criterion"], repeat_override: null, status: "completed",
    });
    const HEADLESS_AGENT = "77777777-7777-4777-8777-777777777777";
    rec.db.query = async (sql: string) => {
      rec.queries.push(sql);
      return (sql.includes("DISTINCT ON") ? [last("heartbeat", AGENT), last("headless", HEADLESS_AGENT)] : []) as never;
    };
    await harness.runJob("nightly-regression");
    const inserts = rec.executes.filter((sql) => sql.startsWith("INSERT INTO") && sql.includes("eval_runs"));
    expect(inserts).toHaveLength(1);
    expect(rec.params.at(rec.executes.indexOf(inserts[0]!))).toContain(HEADLESS_AGENT);
  });

  it("reports the heartbeat tier unavailable on hosts without agents.clone or runs.readLog", async () => {
    const { harness } = await setup({});
    (harness.ctx as { runs?: unknown }).runs = {}; // an older host: no run-log reads
    const overview = await harness.getData<{ tiers: { heartbeat: { available: boolean; reason?: string } } }>("overview", { companyId: COMPANY });
    expect(overview.tiers.heartbeat).toMatchObject({ available: false });
  });
});

describe("heartbeat tier", () => {
  const scenario = { id: "s", prompt: "Approve now.", ablate: "instructions", max_turns: 3 } as EvalScenario;
  const bundle = { id: "b", adapter: "claude_local", instructions: { entryFile: "AGENTS.md", files: { "AGENTS.md": "rules" } }, skills: {} };
  const arm = (id: "with" | "ablated"): EvalArm => ({ id, bundle: id === "with" ? bundle : { ...bundle, instructions: null }, ablation: null });

  const PROJECT = "44444444-4444-4444-8444-444444444444";
  const LOG = [
    { ts: "t", stream: "stdout", seq: 2, chunk: '{"type":"result","subtype":"success","result":"Blocked.","usage":{"input_tokens":1,"output_tokens":1}}\n' },
    { ts: "t", stream: "stdout", seq: 1, chunk: '{"type":"assistant","message":{"content":[{"type":"text","text":"I will not approve."}]}}\n' },
  ].map((r) => JSON.stringify(r)).join("\n");

  function fakeCtx() {
    const clones: unknown[] = [];
    const created: Array<Record<string, unknown>> = [];
    const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];
    const logsRead: string[] = [];
    const ctx = {
      agents: {
        clone: async (_id: string, input: unknown) => {
          clones.push(input);
          return { agent: { id: `clone-${clones.length}` }, requiresApproval: false, droppedConfig: [] };
        },
        invoke: async () => {
          throw new Error("evals deliver the prompt as an issue, never as a bare invoke");
        },
      },
      issues: {
        create: async (input: Record<string, unknown>) => {
          created.push(input);
          return { id: `issue-${created.length}`, ...input };
        },
        update: async (id: string, patch: Record<string, unknown>) => {
          updates.push({ id, patch });
          return { id, ...patch };
        },
      },
      runs: {
        readLog: async (runId: string) => {
          logsRead.push(runId);
          return { content: LOG };
        },
      },
    };
    return { ctx, clones, created, updates, logsRead };
  }

  const TWIN = "66666666-6666-4666-8666-666666666666";
  function executor(ctx: unknown) {
    return createHeartbeatExecutor({
      ctx: ctx as never,
      waitForIssueRun: async (issueId) => ({ status: "succeeded", error: null, runId: `run-of-${issueId}` }),
      agentFor: async (a) => (a.id === "with" ? AGENT : TWIN),
      companyId: COMPANY,
      projectId: PROJECT,
    });
  }

  it("runs the 'with' arm on the agent itself: an eval issue in the Evals project, assigned to the agent, closed afterwards", async () => {
    const { ctx, clones, created, updates, logsRead } = fakeCtx();
    const trace = await executor(ctx)(arm("with"), scenario);
    expect(clones).toHaveLength(0);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      companyId: COMPANY,
      projectId: PROJECT,
      assigneeAgentId: AGENT,
      description: expect.stringContaining("Approve now."),
      originKind: "plugin:paperclipai.plugin-agent-evals",
    });
    expect(created[0]).not.toHaveProperty("assigneeAdapterOverrides");
    expect(logsRead).toEqual(["run-of-issue-1"]);
    expect(updates).toEqual([{ id: "issue-1", patch: { status: "cancelled" } }]);
    expect(trace).toMatchObject({ tier: "heartbeat", finalText: "Blocked.", runRef: "run-of-issue-1", exit: { ok: true } });
    expect(trace.assistantText).toBe("I will not approve.");
  });

  it("delivers the 'ablated' arm the same way, as an eval issue assigned to the twin, without a bare invoke", async () => {
    const { ctx, clones, created } = fakeCtx();
    await executor(ctx)(arm("ablated"), scenario);
    expect(clones).toHaveLength(0); // hiring twins is eval-agents' job, before any attempt runs
    expect(created[0]).toMatchObject({ projectId: PROJECT, assigneeAgentId: TWIN, description: expect.stringContaining("Approve now.") });
  });

  it("closes the eval issue even when the run fails, and reports the failure as an error", async () => {
    const { ctx, updates } = fakeCtx();
    const exec = createHeartbeatExecutor({
      ctx: ctx as never,
      waitForIssueRun: async () => ({ status: "failed", error: "adapter crashed", runId: "r" }),
      agentFor: async () => AGENT, companyId: COMPANY, projectId: PROJECT,
    });
    const trace = await exec(arm("with"), scenario);
    expect(trace.exit).toEqual({ ok: false, error: "adapter crashed" });
    expect(updates).toEqual([{ id: "issue-1", patch: { status: "cancelled" } }]);
  });

  it("matches runs to their eval issue from agent.run.* events, including a run that finished before the wait began", async () => {
    const handlers = new Map<string, (e: unknown) => Promise<void>>();
    const waitForIssueRun = createRunWaiter({ events: { on: (name: string, fn: (e: unknown) => Promise<void>) => handlers.set(name, fn) } } as never);
    await handlers.get("agent.run.failed")!({ entityId: "run-early", payload: { runId: "run-early", issueId: "issue-early", error: "boom" } });
    await expect(waitForIssueRun("issue-early", 1000)).resolves.toEqual({ status: "failed", error: "boom", runId: "run-early" });
    const pending = waitForIssueRun("issue-late", 1000);
    await handlers.get("agent.run.finished")!({ entityId: "run-other", payload: { runId: "run-other", issueId: "unrelated" } });
    await handlers.get("agent.run.finished")!({ entityId: "run-late", payload: { runId: "run-late", issueId: "issue-late" } });
    await expect(pending).resolves.toEqual({ status: "succeeded", error: null, runId: "run-late" });
  });

  it("rebuilds the trace from the run log, where the host keeps adapter stdout, even when chunks split a JSON line", () => {
    // The host stores adapter stdout in the run log as NDJSON records
    // ({ ts, stream, chunk, seq }); run events only carry structured lifecycle
    // entries. Chunks are arbitrary slices of the CLI's stream-json.
    const assistant = '{"type":"assistant","message":{"content":[{"type":"text","text":"I will not approve."}]}}\n';
    const result = '{"type":"result","subtype":"success","is_error":false,"result":"Blocked.","total_cost_usd":0.031,"usage":{"input_tokens":10,"output_tokens":5}}\n';
    const stdout = assistant + result;
    const cut = assistant.length + 20;
    const records = [
      { ts: "t1", stream: "stdout", chunk: stdout.slice(0, 17), seq: 1 },
      { ts: "t2", stream: "stderr", chunk: "[paperclip] warning\n", seq: 2 },
      { ts: "t3", stream: "stdout", chunk: stdout.slice(17, cut), seq: 3 },
      { ts: "t4", stream: "stdout", chunk: stdout.slice(cut), seq: 4 },
    ];
    const log = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const trace = traceFromRunLog(log, { status: "succeeded", error: null }, "run-9");
    expect(trace).toMatchObject({ tier: "heartbeat", finalText: "Blocked.", runRef: "run-9", exit: { ok: true } });
    expect(trace.assistantText).toBe("I will not approve.");
    expect(trace.usage.costUsd).toBeCloseTo(0.031);
  });

  it("reads the whole run log through ctx.runs.readLog, following nextOffset", async () => {
    const line = (chunk: string, seq: number) => `${JSON.stringify({ ts: "t", stream: "stdout", chunk, seq })}\n`;
    const pages = [
      { content: line('{"type":"result","subtype":"success","is_error":false,', 1), nextOffset: 100 },
      { content: line('"result":"Done.","usage":{"input_tokens":1,"output_tokens":1}}\n', 2) },
    ];
    const offsets: number[] = [];
    const runs = { readLog: async (_runId: string, _companyId: string, opts?: { offset?: number }) => {
      offsets.push(opts?.offset ?? 0);
      return pages[offsets.length - 1]!;
    } };
    const content = await readWholeRunLog(runs, "run-1", COMPANY);
    expect(offsets).toEqual([0, 100]);
    expect(traceFromRunLog(content, { status: "succeeded", error: null }, "run-1").finalText).toBe("Done.");
  });

  it("marks failed runs as errors, not behavior", () => {
    expect(traceFromRunEvents([], { status: "failed", error: "adapter crashed" }, "r").exit).toEqual({ ok: false, error: "adapter crashed" });
  });
});
