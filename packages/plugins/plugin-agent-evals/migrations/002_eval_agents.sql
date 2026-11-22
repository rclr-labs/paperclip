-- Long-lived eval agents hired in the agent's own company (see src/eval-agents.ts):
-- an ablated twin per (source agent, ablation, source digest) and one judge per company.
CREATE TABLE plugin_agent_evals_1a9341c5d7.eval_agents (
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  eval_agent_id uuid NOT NULL,
  source_agent_id uuid NOT NULL,
  role text NOT NULL,
  ablation text NOT NULL,
  source_digest text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, eval_agent_id)
);

CREATE INDEX eval_agents_lookup_idx ON plugin_agent_evals_1a9341c5d7.eval_agents (company_id, role, ablation, source_agent_id, source_digest);
