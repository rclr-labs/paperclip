import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agentInstructionHeads,
  agentInstructionRevisions,
  agents,
  approvals,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { agentInstructionsService } from "../services/agent-instructions.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin run-events/agent-clone tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: async () => {}, subscribe: () => {} };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

const PLUGIN_ID = "plugin-record-id";
const PLUGIN_KEY = "paperclip.agent-evals";

describeEmbeddedPostgres("plugin runs.listEvents and agents.clone", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempHome = "";
  const previousEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-run-events-clone-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-clone-home-"));
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_ISSUE_PRIVACY_MODE"]) {
      previousEnv[key] = process.env[key];
    }
    process.env.PAPERCLIP_HOME = tempHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test";
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(principalPermissionGrants);
    await db.delete(agentConfigRevisions);
    await db.delete(agentInstructionHeads);
    await db.delete(agentInstructionRevisions);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(options: { requireApproval?: boolean } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 4)}`,
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: options.requireApproval ?? false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
      ...overrides,
    });
    return agentId;
  }

  async function seedAgentWithInstructions(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const agentId = await seedAgent(companyId, overrides);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const materialized = await agentInstructionsService(db).materializeManagedBundle(
      agent!,
      { "AGENTS.md": "# Source instructions\nAlways write tests first.\n", "TOOLS.md": "Use the shell.\n" },
      { entryFile: "AGENTS.md", replaceExisting: false },
    );
    await db.update(agents).set({ adapterConfig: materialized.adapterConfig }).where(eq(agents.id, agentId));
    return agentId;
  }

  function hostServices() {
    return buildHostServices(db, PLUGIN_ID, PLUGIN_KEY, createEventBusStub());
  }

  async function readInstructions(agentId: string) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    return agentInstructionsService(db).exportFiles(agent!);
  }

  // ---------------------------------------------------------------------------
  // runs.listEvents
  // ---------------------------------------------------------------------------

  async function seedRun(companyId: string, agentId: string, options: { issueId?: string } = {}) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      invocationSource: "assignment",
      ...(options.issueId ? { issueId: options.issueId, scopeKind: "issue" as const } : {}),
      contextSnapshot: options.issueId ? { issueId: options.issueId } : {},
    });
    await db.insert(heartbeatRunEvents).values([
      { companyId, runId, agentId, seq: 1, eventType: "lifecycle", stream: "system", level: "info", message: "started" },
      {
        companyId, runId, agentId, seq: 2, eventType: "adapter.invoke", stream: "system", level: "info",
        message: "invoking", payload: { apiKey: "sk-live-plugin-should-never-see", model: "claude" },
      },
      { companyId, runId, agentId, seq: 3, eventType: "log", stream: "stdout", level: "info", message: "done" },
    ]);
    return runId;
  }

  it("lists run events in seq order with payloads redacted", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const runId = await seedRun(companyId, agentId);

    const events = await hostServices().runs.listEvents({ runId, companyId });

    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events[1]).toMatchObject({ eventType: "adapter.invoke", stream: "system", level: "info", message: "invoking" });
    expect(events[1]?.payload).toMatchObject({ apiKey: REDACTED_EVENT_VALUE, model: "claude" });
    expect(JSON.stringify(events)).not.toContain("sk-live-plugin-should-never-see");
  });

  it("pages run events with afterSeq and limit", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const runId = await seedRun(companyId, agentId);

    const page = await hostServices().runs.listEvents({ runId, companyId, afterSeq: 1, limit: 1 });
    expect(page.map((event) => event.seq)).toEqual([2]);
  });

  it("returns no events for a run outside the requested company", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const agentB = await seedAgent(companyB);
    const runB = await seedRun(companyB, agentB);

    await expect(hostServices().runs.listEvents({ runId: runB, companyId: companyA })).resolves.toEqual([]);
  });

  it("returns no events for a run bound to a private issue when privacy is enforced", async () => {
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const privateIssueId = randomUUID();
    const openIssueId = randomUUID();
    await db.insert(issues).values([
      { id: privateIssueId, companyId, title: "Confidential", status: "todo", priority: "medium", visibility: "private" },
      { id: openIssueId, companyId, title: "Public", status: "todo", priority: "medium", visibility: "open" },
    ]);
    const privateRun = await seedRun(companyId, agentId, { issueId: privateIssueId });
    const openRun = await seedRun(companyId, agentId, { issueId: openIssueId });

    await expect(hostServices().runs.listEvents({ runId: privateRun, companyId })).resolves.toEqual([]);
    await expect(hostServices().runs.listEvents({ runId: openRun, companyId })).resolves.toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // agents.clone
  // ---------------------------------------------------------------------------

  it("clones an agent in the same company with its config, instructions, provenance, and activity log", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedAgentWithInstructions(companyId, {
      name: "Reviewer",
      title: "Code reviewer",
      capabilities: "Reviews pull requests.",
      adapterConfig: { command: "pnpm review", env: { MODE: { type: "plain", value: "strict" } } },
      runtimeConfig: { heartbeat: { enabled: false } },
    });

    const result = await hostServices().agents.clone({
      agentId: sourceId,
      sourceCompanyId: companyId,
      targetCompanyId: companyId,
      name: "Reviewer (eval)",
    });

    expect(result.requiresApproval).toBe(false);
    expect(result.approvalId).toBeNull();
    expect(result.droppedConfig).toEqual([]);
    const clone = result.agent;
    expect(clone.id).not.toBe(sourceId);
    expect(clone).toMatchObject({
      companyId,
      name: "Reviewer (eval)",
      role: "engineer",
      title: "Code reviewer",
      capabilities: "Reviews pull requests.",
      adapterType: "process",
      status: "idle",
    });
    expect(clone.adapterConfig).toMatchObject({ command: "pnpm review", env: { MODE: { type: "plain", value: "strict" } } });
    expect(clone.runtimeConfig).toMatchObject({ heartbeat: { enabled: false } });
    expect(clone.metadata).toMatchObject({ clonedFrom: { agentId: sourceId, companyId, pluginKey: PLUGIN_KEY } });

    const cloned = await readInstructions(clone.id);
    expect(cloned.entryFile).toBe("AGENTS.md");
    expect(cloned.files["AGENTS.md"]).toContain("Always write tests first.");
    expect(cloned.files["TOOLS.md"]).toBe("Use the shell.\n");
    // The clone owns its own bundle; it never points at the source's directory.
    expect(String(clone.adapterConfig.instructionsRootPath)).toContain(clone.id);
    expect(String(clone.adapterConfig.instructionsRootPath)).not.toContain(sourceId);

    const activity = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, clone.id), eq(activityLog.action, "plugin.agent.cloned")));
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ companyId, actorType: "plugin", actorId: PLUGIN_ID, entityType: "agent" });
    expect(activity[0]?.details).toMatchObject({
      sourceAgentId: sourceId,
      sourceCompanyId: companyId,
      instructionsOverridden: false,
      sourcePluginKey: PLUGIN_KEY,
    });
  });

  it("replaces only the entry file with an entry-file instructions override", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedAgentWithInstructions(companyId);

    const result = await hostServices().agents.clone({
      agentId: sourceId,
      sourceCompanyId: companyId,
      targetCompanyId: companyId,
      instructionsOverride: { entryFile: "AGENTS.md", content: "# Ablated\n" },
    });

    const cloned = await readInstructions(result.agent.id);
    expect(cloned.files["AGENTS.md"]).toBe("# Ablated\n");
    expect(cloned.files["TOOLS.md"]).toBe("Use the shell.\n");
    const source = await readInstructions(sourceId);
    expect(source.files["AGENTS.md"]).toContain("Always write tests first.");
    const [activity] = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, result.agent.id), eq(activityLog.action, "plugin.agent.cloned")));
    expect(activity?.details).toMatchObject({ instructionsOverridden: true });
  });

  it("replaces the whole bundle with a files instructions override", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedAgentWithInstructions(companyId);

    const result = await hostServices().agents.clone({
      agentId: sourceId,
      sourceCompanyId: companyId,
      targetCompanyId: companyId,
      instructionsOverride: { files: { "AGENTS.md": "# Only this\n" } },
    });

    const cloned = await readInstructions(result.agent.id);
    expect(cloned.files).toEqual({ "AGENTS.md": "# Only this\n" });
  });

  it("refuses a source agent outside the declared source company and creates nothing", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const agentB = await seedAgent(companyB);

    await expect(hostServices().agents.clone({
      agentId: agentB,
      sourceCompanyId: companyA,
      targetCompanyId: companyA,
    })).rejects.toThrow(/Agent not found/);
    const rows = await db.select({ id: agents.id }).from(agents);
    expect(rows).toHaveLength(1);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("drops company-bound config on a cross-company clone and audits both companies", async () => {
    const source = await seedCompany();
    const target = await seedCompany();
    await db.insert(companySkills).values([
      { companyId: source, key: "shared-skill", slug: "shared-skill", name: "Shared", markdown: "# Shared" },
      { companyId: source, key: "source-only", slug: "source-only", name: "Source only", markdown: "# Source" },
      { companyId: target, key: "shared-skill", slug: "shared-skill", name: "Shared", markdown: "# Shared" },
    ] as never);
    const sourceId = await seedAgentWithInstructions(source, {
      adapterConfig: {
        command: "pnpm review",
        cwd: "/srv/source-company/repo",
        env: { TOKEN: { type: "secret_ref", secretId: randomUUID() } },
        paperclipSkillSync: { desiredSkills: ["shared-skill", "source-only"] },
      },
      runtimeConfig: { heartbeat: { enabled: false } },
    });

    const result = await hostServices().agents.clone({
      agentId: sourceId,
      sourceCompanyId: source,
      targetCompanyId: target,
    });

    expect(result.agent.companyId).toBe(target);
    expect(result.agent.adapterConfig).toMatchObject({ command: "pnpm review" });
    expect(result.agent.adapterConfig.env).toBeUndefined();
    expect(result.agent.adapterConfig.cwd).toBeUndefined();
    expect(result.agent.adapterConfig.paperclipSkillSync).toMatchObject({ desiredSkills: ["shared-skill"] });
    expect(result.droppedConfig).toEqual(expect.arrayContaining([
      "adapterConfig.env",
      "adapterConfig.cwd",
      "adapterConfig.paperclipSkillSync.desiredSkills:source-only",
    ]));
    const cloned = await readInstructions(result.agent.id);
    expect(cloned.files["AGENTS.md"]).toContain("Always write tests first.");

    const targetActivity = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, target), eq(activityLog.action, "plugin.agent.cloned")));
    expect(targetActivity).toHaveLength(1);
    const sourceActivity = await db.select().from(activityLog)
      .where(and(eq(activityLog.companyId, source), eq(activityLog.action, "plugin.agent.cloned_out")));
    expect(sourceActivity).toHaveLength(1);
    expect(sourceActivity[0]).toMatchObject({ entityType: "agent", entityId: sourceId });
    expect(sourceActivity[0]?.details).toMatchObject({ cloneAgentId: result.agent.id, targetCompanyId: target });
  });

  it("creates a pending hire approval when the target company requires board approval", async () => {
    const companyId = await seedCompany({ requireApproval: true });
    const sourceId = await seedAgent(companyId, { budgetMonthlyCents: 500 });

    const result = await hostServices().agents.clone({
      agentId: sourceId,
      sourceCompanyId: companyId,
      targetCompanyId: companyId,
    });

    expect(result.requiresApproval).toBe(true);
    expect(result.agent.status).toBe("pending_approval");
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, result.approvalId!));
    expect(approval).toMatchObject({ type: "hire_agent", status: "pending", companyId });
    expect(approval?.payload).toMatchObject({ agentId: result.agent.id, budgetMonthlyCents: 500, sourcePluginKey: PLUGIN_KEY });
    // The approval path owns the budget policy; none is created before approval.
    expect(await db.select().from(budgetPolicies)).toHaveLength(0);
  });

  it("carries the monthly budget as a hard-stop policy on direct creation", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedAgent(companyId, { budgetMonthlyCents: 1234 });

    const result = await hostServices().agents.clone({
      agentId: sourceId,
      sourceCompanyId: companyId,
      targetCompanyId: companyId,
    });

    expect(result.agent.budgetMonthlyCents).toBe(1234);
    const policies = await db.select().from(budgetPolicies).where(eq(budgetPolicies.scopeId, result.agent.id));
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ companyId, scopeType: "agent", amount: 1234 });
  });

  it("does not copy elevated role or permissions", async () => {
    const companyId = await seedCompany();
    const sourceId = await seedAgent(companyId, { role: "ceo", permissions: { canCreateAgents: true } });

    const result = await hostServices().agents.clone({
      agentId: sourceId,
      sourceCompanyId: companyId,
      targetCompanyId: companyId,
    });

    expect(result.agent.role).toBe("general");
    expect((result.agent.permissions as Record<string, unknown>)?.canCreateAgents).not.toBe(true);
  });
});
