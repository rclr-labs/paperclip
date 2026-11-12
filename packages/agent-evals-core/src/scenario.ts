import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * A pressure scenario for one agent or one skill.
 *
 * Every scenario runs on two arms (see `arms.ts`): `with` the instruction under
 * test and `ablated` without it. A scenario only earns a place in the suite
 * when the ablated arm fails — otherwise it is not testing the instruction.
 */

export const TARGET_SOURCES = ["teams-catalog", "skills-catalog", "instance", "dir"] as const;
export const PRESSURES = ["time", "authority", "sunk-cost", "exhaustion", "consequence", "social"] as const;
export const TIERS = ["headless", "heartbeat"] as const;

const targetRefSchema = z
  .string()
  .regex(
    new RegExp(`^(${TARGET_SOURCES.join("|")}):.+$`),
    `target ref must be "<source>:<path-or-id>" with source in ${TARGET_SOURCES.join(", ")}`,
  );

const singleAblationSchema = z.union([
  z.literal("instructions"),
  z.literal("revision:previous"),
  z.string().regex(/^skill:[a-z0-9][a-z0-9-]*$/, 'skill ablation must be "skill:<slug>"'),
]);

/** One ablation, or several applied together (e.g. instructions + the skill that duplicates them). */
const ablateSchema = z.union([
  singleAblationSchema,
  z.array(singleAblationSchema).min(1).refine((a) => new Set(a).size === a.length, "duplicate ablations"),
]);

const hardCheckSchema = z.union([
  z.object({ contains: z.string().min(1) }).strict(),
  z.object({ not_contains: z.string().min(1) }).strict(),
  z.object({ matches: z.string().min(1) }).strict(),
  z.object({ not_matches: z.string().min(1) }).strict(),
  z
    .object({
      tool_called: z
        .object({ name: z.string().min(1), input_match: z.string().min(1).optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      tool_not_called: z
        .object({ name: z.string().min(1), input_match: z.string().min(1).optional() })
        .strict(),
    })
    .strict(),
  z.object({ skill_used: z.string().min(1) }).strict(),
]);

export const scenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "id must be kebab-case"),
    description: z.string().optional(),
    target: z
      .object({ kind: z.enum(["agent", "skill"]), ref: targetRefSchema })
      .strict(),
    tiers: z.array(z.enum(TIERS)).min(1).default(["headless"]),
    ablate: ablateSchema,
    pressures: z.array(z.enum(PRESSURES)).default([]),
    prompt: z.string().min(1),
    repeat: z.number().int().min(1).max(50).default(5),
    threshold: z.number().gt(0).max(1).default(0.8),
    max_turns: z.number().int().min(1).max(200).default(20),
    checks: z
      .object({
        hard: z.array(hardCheckSchema).default([]),
        rubric: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .refine((c) => c.hard.length + c.rubric.length > 0, "a scenario needs at least one hard check or rubric criterion"),
    capture_rationalization: z.boolean().default(true),
    tags: z.array(z.string()).default([]),
  })
  .strict();

export type EvalScenario = z.infer<typeof scenarioSchema>;
export type Ablation = z.infer<typeof singleAblationSchema>;
export type HardCheck = EvalScenario["checks"]["hard"][number];

export class ScenarioParseError extends Error {
  readonly code = "agent_evals_scenario_invalid" as const;
  constructor(
    message: string,
    readonly source: string,
    readonly issues: readonly string[],
  ) {
    super(message);
    this.name = "ScenarioParseError";
  }
}

/** Parse one scenario from YAML (JSON is valid YAML too). */
export function parseScenario(text: string, source = "<inline>"): EvalScenario {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ScenarioParseError(`${source}: invalid YAML: ${reason}`, source, [reason]);
  }
  const result = scenarioSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
    throw new ScenarioParseError(`${source}: invalid scenario\n  ${issues.join("\n  ")}`, source, issues);
  }
  for (const check of result.data.checks.hard) {
    const pattern = "matches" in check ? check.matches : "not_matches" in check ? check.not_matches : null;
    if (pattern !== null) {
      try {
        new RegExp(pattern);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new ScenarioParseError(`${source}: invalid regex ${pattern}: ${reason}`, source, [reason]);
      }
    }
  }
  return result.data;
}
