import { useMemo, useState } from "react";
import type { PluginDetailTabProps, PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui/hooks";

type TierState = { available: true } | { available: false; reason: string };

interface Overview {
  scenarios: { id: string; description: string | null; source: "bundled" | "company"; tiers: string[]; ablate: string | string[]; repeat: number; pressures: string[] }[];
  invalidScenarios: { scenarioId: string; error: string }[];
  tiers: { headless: TierState; heartbeat: TierState };
  evalCompanyId: string | null;
  allowRealCompany: boolean;
  judge: { enabled: boolean; model?: string };
}

interface RunRow {
  id: string;
  agent_id: string;
  tier: string;
  status: string;
  error: string | null;
  spent_usd: string | number;
  created_at: string;
  finished_at: string | null;
}

interface ScenarioReport {
  scenarioId: string;
  threshold: number;
  with: { attempts: number; errored: number; passRate: number };
  ablated: { attempts: number; errored: number; passRate: number };
  delta: number;
  admission: "admitted" | "decorative" | "regressed" | "inconclusive";
  rationalizations: string[];
  costUsd: number;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

const ADMISSION_HELP: Record<ScenarioReport["admission"], string> = {
  admitted: "The instruction is what makes the agent pass. Keep this scenario.",
  decorative: "The agent passes even without the instruction. The scenario tests nothing.",
  regressed: "The agent fails even with the instruction. Fix the instruction or skill.",
  inconclusive: "Too many attempts errored to judge.",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function RunResults({ companyId, runId }: { companyId: string; runId: string }) {
  const { data, loading, error } = usePluginData<{ run: RunRow | null; results: { scenario_id: string; report: ScenarioReport }[] }>("run", { companyId, runId });
  if (loading) return <p className="text-sm text-muted-foreground">Loading results…</p>;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!data?.run) return null;
  if (data.run.error) return <p className="text-sm text-destructive">Run failed: {data.run.error}</p>;
  if (data.results.length === 0) return <p className="text-sm text-muted-foreground">No results yet.</p>;
  return (
    <div className="flex flex-col gap-3">
      {data.results.map(({ scenario_id, report }) => (
        <div key={scenario_id} className="rounded-md border border-border p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-mono text-sm text-foreground">{scenario_id}</span>
            <span className="text-sm font-medium text-foreground">{report.admission}</span>
          </div>
          <p className="text-sm text-muted-foreground">
            with {pct(report.with.passRate)} ({report.with.attempts}) · without {pct(report.ablated.passRate)} ({report.ablated.attempts}) · Δ {pct(report.delta)} · ${report.costUsd.toFixed(2)}
          </p>
          <p className="text-sm text-muted-foreground">{ADMISSION_HELP[report.admission]}</p>
          {report.rationalizations.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-sm text-foreground">Rationalizations ({report.rationalizations.length})</summary>
              <ul className="mt-1 flex flex-col gap-1">
                {report.rationalizations.map((r, i) => (
                  <li key={i} className="border-l-2 border-border pl-2 text-sm text-muted-foreground">{r}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

function AgentEvalPanel({ companyId, agentId }: { companyId: string; agentId: string }) {
  const overview = usePluginData<Overview>("overview", { companyId });
  const runs = usePluginData<{ runs: RunRow[] }>("runs", { companyId, agentId });
  const queueRun = usePluginAction("queue-run");
  const [selected, setSelected] = useState<string[]>([]);
  const [tier, setTier] = useState<"headless" | "heartbeat">("heartbeat");
  const [useRealCompany, setUseRealCompany] = useState(false);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tierState = overview.data?.tiers[tier];
  const eligible = useMemo(() => (overview.data?.scenarios ?? []).filter((s) => s.tiers.includes(tier)), [overview.data, tier]);

  async function submit() {
    if (useRealCompany && !window.confirm("This run creates issues and spends budget in this agent's own company. Continue?")) return;
    setBusy(true);
    setMessage(null);
    try {
      await queueRun({ companyId, agentId, tier, scenarioIds: selected, useRealCompany, confirmRealCompany: useRealCompany });
      setMessage("Queued. The run starts within 5 minutes.");
      setSelected([]);
      runs.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (overview.loading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (overview.error) return <p className="text-sm text-destructive">{overview.error.message}</p>;

  return (
    <div className="flex flex-col gap-6">
      <Section title="New eval run">
        <div className="flex flex-wrap items-center gap-3 text-sm text-foreground">
          <label className="flex items-center gap-2">
            Tier
            <select className="rounded-md border border-border bg-background px-2 py-1" value={tier} onChange={(e) => setTier(e.target.value as "headless" | "heartbeat")}>
              <option value="heartbeat">Heartbeat (real Paperclip run)</option>
              <option value="headless">Headless (claude -p)</option>
            </select>
          </label>
          {tier === "heartbeat" && overview.data?.allowRealCompany && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={useRealCompany} onChange={(e) => setUseRealCompany(e.target.checked)} />
              Run in this agent's own company instead of the eval company
            </label>
          )}
        </div>
        {tierState && !tierState.available && <p className="text-sm text-muted-foreground">Unavailable: {tierState.reason}</p>}
        {!overview.data?.judge.enabled && <p className="text-sm text-muted-foreground">No judge configured: only deterministic checks decide.</p>}
        <ul className="flex flex-col gap-1">
          {eligible.map((s) => (
            <li key={s.id}>
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={selected.includes(s.id)}
                  onChange={(e) => setSelected((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))}
                />
                <span>
                  <span className="font-mono">{s.id}</span>
                  <span className="text-muted-foreground"> · {s.source} · {s.repeat}× · without {Array.isArray(s.ablate) ? s.ablate.join(" + ") : s.ablate}</span>
                  {s.description && <span className="block text-muted-foreground">{s.description}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            disabled={busy || selected.length === 0 || !tierState?.available}
            onClick={submit}
          >
            Queue run
          </button>
          {message && <span className="text-sm text-muted-foreground">{message}</span>}
        </div>
      </Section>

      <Section title="Runs">
        {runs.error && <p className="text-sm text-destructive">{runs.error.message}</p>}
        {(runs.data?.runs ?? []).length === 0 && <p className="text-sm text-muted-foreground">No runs yet.</p>}
        <ul className="flex flex-col gap-2">
          {(runs.data?.runs ?? []).map((r) => (
            <li key={r.id} className="flex flex-col gap-2">
              <button type="button" className="text-left text-sm text-foreground hover:underline" onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
                {new Date(r.created_at).toLocaleString()} · {r.tier} · {r.status}
                {r.finished_at ? ` · $${Number(r.spent_usd).toFixed(2)}` : ""}
              </button>
              {openRun === r.id && <RunResults companyId={companyId} runId={r.id} />}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

export function AgentEvalsTab({ context }: PluginDetailTabProps) {
  if (!context.companyId || !context.entityId) return null;
  return <AgentEvalPanel companyId={context.companyId} agentId={context.entityId} />;
}

export function EvalsPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  const agents = usePluginData<{ agents: { id: string; name: string; role: string }[] }>("agents", { companyId });
  const importScenario = usePluginAction("import-scenario");
  const [agentId, setAgentId] = useState("");
  const [yaml, setYaml] = useState("");
  const [importMessage, setImportMessage] = useState<string | null>(null);

  if (!companyId) return <p className="text-sm text-muted-foreground">Select a company.</p>;

  async function submitImport() {
    setImportMessage(null);
    const result = (await importScenario({ companyId, yaml })) as { ok: boolean; scenarioId?: string; error?: string };
    setImportMessage(result.ok ? `Imported ${result.scenarioId}.` : (result.error ?? "Import failed."));
    if (result.ok) setYaml("");
  }

  return (
    <div className="flex flex-col gap-8 p-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-foreground">Agent evals</h2>
        <p className="text-sm text-muted-foreground">
          Each scenario runs with the instruction under test and without it. A scenario is kept only when the instruction is what makes the agent pass.
        </p>
      </header>

      <Section title="Agent">
        <select className="max-w-sm rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">Pick an agent…</option>
          {(agents.data?.agents ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.role})
            </option>
          ))}
        </select>
      </Section>

      {agentId && <AgentEvalPanel companyId={companyId} agentId={agentId} />}

      <Section title="Import scenario (YAML)">
        <textarea
          className="min-h-40 rounded-md border border-border bg-background p-2 font-mono text-sm text-foreground"
          value={yaml}
          onChange={(e) => setYaml(e.target.value)}
          placeholder={"id: my-scenario\ntarget: { kind: agent, ref: \"instance:<agent-id>\" }\nablate: instructions\nprompt: |\n  ...\nchecks:\n  hard:\n    - matches: \"DECISION:\\\\s*REJECT\"\n"}
        />
        <div className="flex items-center gap-3">
          <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" disabled={!yaml.trim()} onClick={submitImport}>
            Import
          </button>
          {importMessage && <span className="text-sm text-muted-foreground">{importMessage}</span>}
        </div>
      </Section>
    </div>
  );
}
