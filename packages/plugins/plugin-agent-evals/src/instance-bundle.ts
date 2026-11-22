import path from "node:path";
import { readTree, type EvalBundle } from "@paperclipai/agent-evals-core";
import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Build an EvalBundle for an agent of this instance from what the host
 * reports in `ctx.agents.getRuntime`: the instruction entry (content, plus the
 * sibling files under `instructionsRootPath`) and each mounted skill's source
 * directory. Paths are host paths, so this works for a worker running on the
 * same host as the server (the default deployment).
 */
export async function loadInstanceAgentBundle(ctx: Pick<PluginContext, "agents">, agentId: string, companyId: string): Promise<EvalBundle> {
  const runtime = await ctx.agents.getRuntime(agentId, companyId);
  if (!runtime) throw new Error(`agent ${agentId} not found in company ${companyId}`);
  const entryFile = runtime.instructionsEntryFile ?? "AGENTS.md";

  let instructions: EvalBundle["instructions"] = null;
  if (runtime.instructionsRootPath) {
    const files = await readTree(runtime.instructionsRootPath).catch(() => ({}) as Record<string, string>);
    const entry = runtime.instructionsEntryContent ?? files[entryFile];
    if (entry !== undefined) instructions = { entryFile, files: { ...files, [entryFile]: entry } };
  } else if (runtime.instructionsEntryContent) {
    instructions = { entryFile, files: { [entryFile]: runtime.instructionsEntryContent } };
  }

  const skills: Record<string, Record<string, string>> = {};
  for (const skill of runtime.skills) {
    if (!skill.source || skill.sourceStatus === "missing") continue;
    const slug = skill.runtimeName || path.basename(skill.source);
    skills[slug] = await readTree(skill.source).catch(() => ({}));
  }

  const config = (runtime.agent as { adapterConfig?: Record<string, unknown> }).adapterConfig ?? {};
  return {
    id: `instance:${agentId}`,
    adapter: (runtime.agent as { adapterType?: string }).adapterType ?? "unknown",
    model: typeof config.model === "string" ? config.model : undefined,
    instructions,
    skills,
    revision: (runtime as { revision?: unknown }).revision !== undefined ? String((runtime as { revision?: unknown }).revision) : undefined,
  };
}

interface AgentRecord {
  id: string;
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown> | null;
}

/**
 * Bundle for the heartbeat tier, from the agent record alone.
 *
 * `getRuntime` (file contents and skill sources) is reserved by the host for
 * the plugin that owns the agent's lifecycle, and the heartbeat tier does not
 * need contents: both arms run on real agents, and the ablated twin is made by
 * the host's clone. The bundle only has to say what can be ablated (an
 * instruction entry, the desired skills by slug) and key the twin (adapter,
 * model, skills). Instruction file contents are not read, so editing them does
 * not hire a new twin; a twin that drops `instructions` is blank either way.
 */
export function heartbeatAgentBundle(agent: AgentRecord): EvalBundle {
  const config = agent.adapterConfig ?? {};
  const entryFile = typeof config.instructionsEntryFile === "string" && config.instructionsEntryFile ? config.instructionsEntryFile : "AGENTS.md";
  const hasInstructions = ["instructionsBundleMode", "instructionsFilePath", "instructionsRootPath"].some(
    (key) => typeof config[key] === "string" && (config[key] as string).length > 0,
  );
  const sync = config.paperclipSkillSync as { desiredSkills?: unknown[] } | undefined;
  const skills: Record<string, Record<string, string>> = {};
  for (const entry of sync?.desiredSkills ?? []) {
    const key = typeof entry === "string" ? entry : (entry as { key?: unknown } | null)?.key;
    if (typeof key !== "string" || !key.trim()) continue;
    skills[key.trim().split("/").pop()!] = {};
  }
  return {
    id: `instance:${agent.id}`,
    adapter: agent.adapterType ?? "unknown",
    model: typeof config.model === "string" ? config.model : undefined,
    instructions: hasInstructions ? { entryFile, files: {} } : null,
    skills,
  };
}
