import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { EvalBundle } from "./arms.js";

/**
 * Load an EvalBundle from an on-disk agent directory (teams-catalog layout:
 * `<agentDir>/AGENTS.md` with YAML frontmatter listing `skills:`), resolving
 * each skill slug against the given skill roots (skills-catalog layout:
 * `<root>/<category>/<slug>/SKILL.md` or `<root>/<slug>/SKILL.md`).
 *
 * Instance agents are loaded by the plugin through the Paperclip API instead;
 * both paths produce the same EvalBundle.
 */

export function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized.trim() };
  const closing = normalized.indexOf("\n---", 4);
  if (closing < 0) return { frontmatter: {}, body: normalized.trim() };
  const parsed = parseYaml(normalized.slice(4, closing));
  const frontmatter = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  return { frontmatter, body: normalized.slice(closing + 4).trim() };
}

export async function readTree(dir: string, base = dir): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await readTree(full, base));
    else if (entry.isFile()) out[path.relative(base, full).split(path.sep).join("/")] = await fs.readFile(full, "utf8");
  }
  return out;
}

async function isFile(p: string): Promise<boolean> {
  return fs.stat(p).then((s) => s.isFile(), () => false);
}

export async function findSkillDir(slug: string, skillRoots: readonly string[]): Promise<string | null> {
  for (const root of skillRoots) {
    if (await isFile(path.join(root, slug, "SKILL.md"))) return path.join(root, slug);
    const categories = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const cat of categories) {
      if (cat.isDirectory() && (await isFile(path.join(root, cat.name, slug, "SKILL.md")))) return path.join(root, cat.name, slug);
    }
  }
  return null;
}

export async function loadSkill(slug: string, skillRoots: readonly string[]): Promise<Record<string, string>> {
  const dir = await findSkillDir(slug, skillRoots);
  if (!dir) throw new Error(`skill "${slug}" not found in ${skillRoots.join(", ")}`);
  return readTree(dir);
}

export async function loadAgentBundleFromDir(input: {
  id: string;
  agentDir: string;
  skillRoots: readonly string[];
  adapter?: string;
  model?: string;
}): Promise<EvalBundle> {
  const entryPath = path.join(input.agentDir, "AGENTS.md");
  const files = await readTree(input.agentDir);
  const entryRaw = files["AGENTS.md"];
  if (entryRaw === undefined) throw new Error(`${entryPath} not found`);
  const { frontmatter, body } = splitFrontmatter(entryRaw);
  const declared = Array.isArray(frontmatter.skills) ? frontmatter.skills.filter((s): s is string => typeof s === "string") : [];
  const skills: Record<string, Record<string, string>> = {};
  for (const slug of declared) skills[slug] = await loadSkill(slug, input.skillRoots);
  return {
    id: input.id,
    adapter: input.adapter ?? "claude_local",
    model: input.model,
    instructions: { entryFile: "AGENTS.md", files: { ...files, "AGENTS.md": body } },
    skills,
  };
}

/** A skill under test on its own: no agent instructions, just the skill. */
export async function loadSkillBundle(input: { id: string; slug: string; skillRoots: readonly string[]; model?: string }): Promise<EvalBundle> {
  return {
    id: input.id,
    adapter: "claude_local",
    model: input.model,
    instructions: null,
    skills: { [input.slug]: await loadSkill(input.slug, input.skillRoots) },
  };
}
