-- Namespace: plugin_agent_evals_ + sha256("paperclipai.plugin-agent-evals")[0:10]

-- Scenarios a company has imported (bundled packs are read from disk, not stored).
CREATE TABLE plugin_agent_evals_1a9341c5d7.scenarios (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  scenario_id text NOT NULL,
  yaml text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, scenario_id)
);

-- One requested eval run: an agent, a set of scenarios, a tier, where to execute.
-- Runs are queued by the UI and executed by the `run-queued-evals` job, because
-- cloning an agent into the eval company is only admitted from a proactive call.
CREATE TABLE plugin_agent_evals_1a9341c5d7.eval_runs (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  tier text NOT NULL,
  target_company_id uuid NOT NULL,
  scenario_ids jsonb NOT NULL,
  repeat_override integer,
  status text NOT NULL DEFAULT 'queued',
  error text,
  spent_usd numeric NOT NULL DEFAULT 0,
  requested_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE INDEX eval_runs_company_created_idx ON plugin_agent_evals_1a9341c5d7.eval_runs (company_id, created_at DESC);
CREATE INDEX eval_runs_status_idx ON plugin_agent_evals_1a9341c5d7.eval_runs (status);

-- Per-scenario report (pass rates per arm, admission, rationalizations) and raw attempts.
CREATE TABLE plugin_agent_evals_1a9341c5d7.eval_results (
  run_id uuid NOT NULL REFERENCES plugin_agent_evals_1a9341c5d7.eval_runs(id) ON DELETE CASCADE,
  scenario_id text NOT NULL,
  admission text NOT NULL,
  report jsonb NOT NULL,
  attempts jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, scenario_id)
);
