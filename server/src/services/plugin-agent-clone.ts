import { generateKeyPairSync } from "node:crypto";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, companySkills } from "@paperclipai/db";
import type {
  Agent,
  PluginAgentCloneInstructionsOverride,
  PluginAgentCloneResult,
} from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { createAgentLifecycle } from "./agent-lifecycle.js";
import { agentInstructionsBundleMode, agentInstructionsService } from "./agent-instructions.js";
import { agentService } from "./agents.js";
import { approvalService } from "./approvals.js";
import { budgetService } from "./budgets.js";
import { notFound, unprocessable } from "../errors.js";

/**
 * Adapter-config keys that point at the source agent's own instruction files.
 * The clone always gets its own managed bundle, so these are never copied.
 */
const INSTRUCTION_CONFIG_KEYS = [
  "instructionsFilePath",
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
  "agentsMdPath",
  "promptTemplate",
  "bootstrapPromptTemplate",
] as const;

/** Legacy keys from which the instructions service can read source content. */
const LEGACY_INSTRUCTION_KEYS = ["promptTemplate", "instructionsFilePath", "agentsMdPath"] as const;

const DEFAULT_ENTRY_FILE = "AGENTS.md";

export interface PluginAgentCloneInput {
  agentId: string;
  sourceCompanyId: string;
  targetCompanyId: string;
  name?: string;
  instructionsOverride?: PluginAgentCloneInstructionsOverride;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Create copies of agents for a plugin holding `agents.clone`.
 *
 * Company scope is checked twice: the SDK gate admits the call only when both
 * companies are in the plugin's scope, and this service requires the source
 * agent to belong to the declared source company. Creation goes through the
 * standard hire lifecycle, so the target company's approval gate, default
 * grants, secret normalization, and budget policy all apply to the clone.
 */
export function pluginAgentCloneService(db: Db, plugin: { pluginId: string; pluginKey: string }) {
  const agentSvc = agentService(db);
  const lifecycle = createAgentLifecycle(db);
  const approvals = approvalService(db);
  const instructions = agentInstructionsService(db);
  const budgets = budgetService(db);

  async function resolveInstructionFiles(
    source: Agent,
    override: PluginAgentCloneInstructionsOverride | undefined,
  ): Promise<{ files: Record<string, string>; entryFile: string } | null> {
    if (override && "files" in override) {
      const files = override.files ?? {};
      if (Object.keys(files).length === 0) throw unprocessable("instructionsOverride.files must contain at least one file");
      const entryFile = nonEmptyString(override.entryFile)
        ?? (DEFAULT_ENTRY_FILE in files ? DEFAULT_ENTRY_FILE : Object.keys(files)[0]!);
      if (!(entryFile in files)) throw unprocessable(`instructionsOverride.entryFile "${entryFile}" is not in files`);
      return { files: { ...files }, entryFile };
    }

    const sourceConfig = isRecord(source.adapterConfig) ? source.adapterConfig : {};
    const hasSourceInstructions = agentInstructionsBundleMode(source) !== null
      || LEGACY_INSTRUCTION_KEYS.some((key) => nonEmptyString(sourceConfig[key]) !== null);
    const exported = hasSourceInstructions
      ? await instructions.exportFiles(source, { rejectSymlinks: true })
      : { files: {} as Record<string, string>, entryFile: DEFAULT_ENTRY_FILE };

    if (override) {
      const entryFile = nonEmptyString(override.entryFile);
      if (!entryFile) throw unprocessable("instructionsOverride.entryFile is required");
      if (typeof override.content !== "string") throw unprocessable("instructionsOverride.content must be a string");
      return { files: { ...exported.files, [entryFile]: override.content }, entryFile };
    }
    return hasSourceInstructions ? { files: exported.files, entryFile: exported.entryFile } : null;
  }

  /** Keep only desired skills that exist in the target company; report the rest. */
  async function retargetSkills(
    adapterConfig: Record<string, unknown>,
    targetCompanyId: string,
    dropped: string[],
  ) {
    const sync = adapterConfig.paperclipSkillSync;
    if (!isRecord(sync) || !Array.isArray(sync.desiredSkills)) return;
    const keys = sync.desiredSkills.flatMap((entry) => {
      const key = typeof entry === "string" ? entry : isRecord(entry) ? entry.key : null;
      const trimmed = nonEmptyString(key);
      return trimmed ? [trimmed] : [];
    });
    const available = keys.length === 0 ? new Set<string>() : new Set(
      (await db.select({ key: companySkills.key }).from(companySkills)
        .where(and(eq(companySkills.companyId, targetCompanyId), inArray(companySkills.key, keys))))
        .map((row) => row.key),
    );
    const kept: string[] = [];
    for (const key of keys) {
      if (available.has(key)) kept.push(key);
      else dropped.push(`adapterConfig.paperclipSkillSync.desiredSkills:${key}`);
    }
    // Version pins name source-company skill versions, so the clone tracks the
    // target company's current version of each kept skill.
    adapterConfig.paperclipSkillSync = { ...sync, desiredSkills: kept };
  }

  async function buildCloneConfig(source: Agent, cloneId: string, crossCompany: boolean, targetCompanyId: string) {
    const dropped: string[] = [];
    const adapterConfig: Record<string, unknown> = isRecord(source.adapterConfig) ? { ...source.adapterConfig } : {};
    for (const key of INSTRUCTION_CONFIG_KEYS) delete adapterConfig[key];

    // A gateway device key is the source agent's identity; never share it.
    if ("devicePrivateKeyPem" in adapterConfig) {
      delete adapterConfig.devicePrivateKeyPem;
      if (source.adapterType === "openclaw_gateway" && adapterConfig.disableDeviceAuth !== true) {
        const { privateKey } = generateKeyPairSync("ed25519");
        adapterConfig.devicePrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      }
    }

    const runtimeConfig: Record<string, unknown> = isRecord(source.runtimeConfig) ? { ...source.runtimeConfig } : {};
    let defaultEnvironmentId = source.defaultEnvironmentId ?? null;

    if (crossCompany) {
      // Env bindings can reference source-company secrets or carry plain
      // credentials; the cwd is a source-company workspace; the AI connection
      // and default environment are source-company resources.
      for (const key of ["env", "cwd"] as const) {
        if (key in adapterConfig) {
          delete adapterConfig[key];
          dropped.push(`adapterConfig.${key}`);
        }
      }
      if ("aiConnection" in runtimeConfig) {
        delete runtimeConfig.aiConnection;
        dropped.push("runtimeConfig.aiConnection");
      }
      if (defaultEnvironmentId) {
        defaultEnvironmentId = null;
        dropped.push("defaultEnvironmentId");
      }
      await retargetSkills(adapterConfig, targetCompanyId, dropped);
    } else if (isRecord(adapterConfig.env)) {
      // A per-agent CODEX_HOME belongs to the source agent; point the clone at its own.
      const env = { ...adapterConfig.env };
      const codexHome = nonEmptyString(env.CODEX_HOME);
      const sourceHomeSegment = `agents/${source.id}/codex-home`;
      if (codexHome?.replaceAll("\\", "/").endsWith(sourceHomeSegment)) {
        env.CODEX_HOME = `${codexHome.slice(0, codexHome.length - sourceHomeSegment.length)}agents/${cloneId}/codex-home`;
        adapterConfig.env = env;
      }
    }

    return { adapterConfig, runtimeConfig, defaultEnvironmentId, dropped };
  }

  async function clone(input: PluginAgentCloneInput): Promise<PluginAgentCloneResult> {
    const source = await agentSvc.getById(input.agentId) as Agent | null;
    if (!source || source.companyId !== input.sourceCompanyId) throw notFound("Agent not found");
    const company = await db.select().from(companies).where(eq(companies.id, input.targetCompanyId))
      .then((rows) => rows[0] ?? null);
    if (!company) throw notFound("Company not found");

    const crossCompany = input.sourceCompanyId !== input.targetCompanyId;
    const cloneId = randomUUID();
    const instructionFiles = await resolveInstructionFiles(source, input.instructionsOverride);
    const config = await buildCloneConfig(source, cloneId, crossCompany, input.targetCompanyId);
    const requiresApproval = company.requireBoardApprovalForNewAgents;
    const name = nonEmptyString(input.name) ?? source.name;

    let created = await lifecycle.requestHire(input.targetCompanyId, {
      id: cloneId,
      name,
      // A company has one CEO; a clone is never a second one.
      role: source.role === "ceo" ? "general" : source.role,
      title: source.title,
      icon: source.icon,
      capabilities: source.capabilities,
      reportsTo: null,
      adapterType: source.adapterType,
      adapterConfig: config.adapterConfig,
      runtimeConfig: config.runtimeConfig,
      defaultEnvironmentId: config.defaultEnvironmentId,
      budgetMonthlyCents: source.budgetMonthlyCents ?? 0,
      // Elevated permissions are granted by a board user, not inherited.
      permissions: {},
      status: requiresApproval ? "pending_approval" : "idle",
      metadata: {
        clonedFrom: { agentId: source.id, companyId: source.companyId, pluginKey: plugin.pluginKey },
      },
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    }, { runnerResolved: true }) as Agent;

    if (instructionFiles) {
      const materialized = await instructions.materializeManagedBundle(created, instructionFiles.files, {
        entryFile: instructionFiles.entryFile,
        replaceExisting: false,
        clearLegacyPromptTemplate: true,
      });
      created = (await agentSvc.update(created.id, { adapterConfig: materialized.adapterConfig }, {
        allowPendingApprovalConfigUpdate: true,
      }) as Agent | null) ?? { ...created, adapterConfig: materialized.adapterConfig };
    }

    let approvalId: string | null = null;
    if (requiresApproval) {
      const approval = await approvals.create(input.targetCompanyId, {
        type: "hire_agent",
        requestedByAgentId: null,
        requestedByUserId: null,
        status: "pending",
        payload: {
          name: created.name,
          role: created.role,
          title: created.title,
          icon: created.icon,
          reportsTo: created.reportsTo,
          capabilities: created.capabilities,
          adapterType: created.adapterType,
          adapterConfig: created.adapterConfig,
          runtimeConfig: created.runtimeConfig,
          budgetMonthlyCents: created.budgetMonthlyCents,
          metadata: created.metadata,
          agentId: created.id,
          sourcePluginId: plugin.pluginId,
          sourcePluginKey: plugin.pluginKey,
          clonedFromAgentId: source.id,
        },
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        updatedAt: new Date(),
      });
      approvalId = approval.id;
      await logActivity(db, {
        companyId: input.targetCompanyId,
        actorType: "plugin",
        actorId: plugin.pluginId,
        action: "approval.created",
        entityType: "approval",
        entityId: approval.id,
        details: { type: "hire_agent", linkedAgentId: created.id, sourcePluginKey: plugin.pluginKey },
      });
    } else if (created.budgetMonthlyCents > 0) {
      // Direct creation: carry the monthly budget as the agent's hard-stop
      // policy, as agent creation does. The approval path sets it on approve.
      await budgets.upsertPolicy(input.targetCompanyId, {
        scopeType: "agent",
        scopeId: created.id,
        amount: created.budgetMonthlyCents,
        windowKind: "calendar_month_utc",
      }, null);
    }

    const details = {
      sourceAgentId: source.id,
      sourceCompanyId: source.companyId,
      targetCompanyId: input.targetCompanyId,
      instructionsOverridden: input.instructionsOverride !== undefined,
      requiresApproval,
      approvalId,
      droppedConfig: config.dropped,
      sourcePluginKey: plugin.pluginKey,
    };
    await logActivity(db, {
      companyId: input.targetCompanyId,
      actorType: "plugin",
      actorId: plugin.pluginId,
      action: "plugin.agent.cloned",
      entityType: "agent",
      entityId: created.id,
      details,
    });
    if (crossCompany) {
      // The source company's audit trail records that its agent was copied out.
      await logActivity(db, {
        companyId: source.companyId,
        actorType: "plugin",
        actorId: plugin.pluginId,
        action: "plugin.agent.cloned_out",
        entityType: "agent",
        entityId: source.id,
        details: { ...details, cloneAgentId: created.id },
      });
    }

    return { agent: created, requiresApproval, approvalId, droppedConfig: config.dropped };
  }

  return { clone };
}
