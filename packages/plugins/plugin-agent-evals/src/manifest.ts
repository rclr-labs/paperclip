import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-agent-evals";
export const JOB_RUN_QUEUED = "run-queued-evals";
export const JOB_NIGHTLY = "nightly-regression";

/**
 * Capabilities the heartbeat tier needs on top of this list. They are added by
 * the plugin SDK extension (`runs.events.read`, `agents.clone`); until the host
 * ships them the worker reports the heartbeat tier as unavailable instead of
 * failing at install time on an unknown capability.
 */
export const HEARTBEAT_TIER_CAPABILITIES = ["runs.events.read", "agents.clone"] as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Agent Evals",
  description:
    "Pressure-test agent instructions and skills: every scenario runs with the instruction and without it, and only scenarios the instruction makes pass are kept.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities: [
    "companies.read",
    "agents.read",
    "agents.lifecycle.manage",
    "agents.invoke",
    "issues.read",
    "issues.create",
    "events.subscribe",
    "jobs.schedule",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "secrets.read-ref",
    "http.outbound",
    "activity.log.write",
    "ui.page.register",
    "ui.detailTab.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  database: {
    namespaceSlug: "agent_evals",
    migrationsDir: "migrations",
    coreReadTables: ["companies"],
  },
  jobs: [
    {
      jobKey: JOB_RUN_QUEUED,
      displayName: "Run queued evals",
      description: "Executes eval runs requested from the Evals page.",
      schedule: "*/5 * * * *",
    },
    {
      jobKey: JOB_NIGHTLY,
      displayName: "Nightly eval regression",
      description: "Re-queues the most recent eval run of every agent so instruction regressions show up the next morning. Reports only; never blocks anything.",
      schedule: "0 3 * * *",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      evalCompanyId: {
        type: "string",
        title: "Eval company",
        description: "Company where heartbeat-tier evals clone agents and create issues. Create a dedicated company (for example \"eval-sandbox\") so evals never touch real work or budgets.",
      },
      allowRealCompany: {
        type: "boolean",
        title: "Allow running in the agent's own company",
        description: "Off by default. When on, a run can target the agent's real company after an explicit confirmation; its issues still carry the plugin origin for cleanup.",
        default: false,
      },
      headlessEnabled: {
        type: "boolean",
        title: "Enable headless tier",
        description: "Runs `claude -p` on the worker host. Needs the Claude CLI and a credential on that host.",
        default: false,
      },
      judgeModel: {
        type: "string",
        title: "Judge model",
        default: "claude-opus-5-5",
      },
      judgeApiKey: {
        type: "string",
        format: "secret-ref",
        title: "Anthropic API key for the rubric judge",
        description: "Optional. Without it, only deterministic checks decide.",
      },
      maxDollarsPerRun: {
        type: "number",
        title: "Budget per eval run (USD)",
        default: 5,
      },
    },
  },
  ui: {
    slots: [
      { type: "page", id: "evals-page", displayName: "Evals", exportName: "EvalsPage", routePath: "evals" },
      { type: "detailTab", id: "agent-evals-tab", displayName: "Evals", exportName: "AgentEvalsTab", entityTypes: ["agent"] },
    ],
  },
};

export default manifest;
