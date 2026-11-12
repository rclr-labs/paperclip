import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AttemptResult, ScenarioReport } from "@paperclipai/agent-evals-core";

export type EvalTier = "headless" | "heartbeat";
export type RunStatus = "queued" | "running" | "completed" | "failed";

export interface EvalRunRow {
  id: string;
  company_id: string;
  agent_id: string;
  tier: EvalTier;
  target_company_id: string;
  scenario_ids: string[];
  repeat_override: number | null;
  status: RunStatus;
  error: string | null;
  spent_usd: string | number;
  requested_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface EvalResultRow {
  run_id: string;
  scenario_id: string;
  admission: ScenarioReport["admission"];
  report: ScenarioReport;
  attempts: AttemptResult[];
}

/** Thin data access over the plugin's namespaced tables (see migrations/001_agent_evals.sql). */
export function createStore(ctx: Pick<PluginContext, "db">) {
  const t = (name: string) => `${ctx.db.namespace}.${name}`;
  return {
    async listCompanyScenarios(companyId: string): Promise<{ scenario_id: string; yaml: string }[]> {
      return ctx.db.query(`SELECT scenario_id, yaml FROM ${t("scenarios")} WHERE company_id = $1 ORDER BY scenario_id`, [companyId]);
    },
    async upsertScenario(companyId: string, scenarioId: string, yaml: string): Promise<void> {
      await ctx.db.execute(
        `INSERT INTO ${t("scenarios")} (company_id, scenario_id, yaml) VALUES ($1, $2, $3)
         ON CONFLICT (company_id, scenario_id) DO UPDATE SET yaml = EXCLUDED.yaml, updated_at = now()`,
        [companyId, scenarioId, yaml],
      );
    },
    async queueRun(run: Pick<EvalRunRow, "id" | "company_id" | "agent_id" | "tier" | "target_company_id" | "scenario_ids" | "repeat_override" | "requested_by">): Promise<void> {
      await ctx.db.execute(
        `INSERT INTO ${t("eval_runs")} (id, company_id, agent_id, tier, target_company_id, scenario_ids, repeat_override, requested_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [run.id, run.company_id, run.agent_id, run.tier, run.target_company_id, JSON.stringify(run.scenario_ids), run.repeat_override, run.requested_by],
      );
    },
    async listQueuedRuns(limit = 5): Promise<EvalRunRow[]> {
      return ctx.db.query(`SELECT * FROM ${t("eval_runs")} WHERE status = 'queued' ORDER BY created_at LIMIT $1`, [limit]);
    },
    /** Claim a queued run; returns false when another worker took it first. */
    async claimRun(id: string): Promise<boolean> {
      const { rowCount } = await ctx.db.execute(
        `UPDATE ${t("eval_runs")} SET status = 'running', started_at = now() WHERE id = $1 AND status = 'queued'`,
        [id],
      );
      return rowCount === 1;
    },
    async finishRun(id: string, status: Extract<RunStatus, "completed" | "failed">, spentUsd: number, error: string | null): Promise<void> {
      await ctx.db.execute(
        `UPDATE ${t("eval_runs")} SET status = $2, spent_usd = $3, error = $4, finished_at = now() WHERE id = $1`,
        [id, status, spentUsd, error],
      );
    },
    async saveResult(runId: string, report: ScenarioReport, attempts: AttemptResult[]): Promise<void> {
      await ctx.db.execute(
        `INSERT INTO ${t("eval_results")} (run_id, scenario_id, admission, report, attempts) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
         ON CONFLICT (run_id, scenario_id) DO UPDATE SET admission = EXCLUDED.admission, report = EXCLUDED.report, attempts = EXCLUDED.attempts`,
        [runId, report.scenarioId, report.admission, JSON.stringify(report), JSON.stringify(attempts)],
      );
    },
    async listRuns(companyId: string, agentId?: string, limit = 50): Promise<EvalRunRow[]> {
      return agentId
        ? ctx.db.query(`SELECT * FROM ${t("eval_runs")} WHERE company_id = $1 AND agent_id = $2 ORDER BY created_at DESC LIMIT $3`, [companyId, agentId, limit])
        : ctx.db.query(`SELECT * FROM ${t("eval_runs")} WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`, [companyId, limit]);
    },
    async getRun(companyId: string, runId: string): Promise<EvalRunRow | null> {
      const rows = await ctx.db.query<EvalRunRow>(`SELECT * FROM ${t("eval_runs")} WHERE company_id = $1 AND id = $2`, [companyId, runId]);
      return rows[0] ?? null;
    },
    async listResults(runId: string): Promise<EvalResultRow[]> {
      return ctx.db.query(`SELECT run_id, scenario_id, admission, report, attempts FROM ${t("eval_results")} WHERE run_id = $1 ORDER BY scenario_id`, [runId]);
    },
    /** Latest finished run per agent, for the nightly regression job. */
    async latestRunPerAgent(): Promise<EvalRunRow[]> {
      return ctx.db.query(
        `SELECT DISTINCT ON (company_id, agent_id) * FROM ${t("eval_runs")}
         WHERE status IN ('completed', 'failed') ORDER BY company_id, agent_id, created_at DESC`,
      );
    },
  };
}

export type EvalStore = ReturnType<typeof createStore>;
