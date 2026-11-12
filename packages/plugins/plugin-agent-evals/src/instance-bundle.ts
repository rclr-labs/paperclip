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
