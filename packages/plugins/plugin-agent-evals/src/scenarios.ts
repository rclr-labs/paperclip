import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseScenario, ScenarioParseError, type EvalScenario } from "@paperclipai/agent-evals-core";
import type { EvalStore } from "./store.js";

export interface CatalogScenario {
  readonly scenario: EvalScenario;
  readonly source: "bundled" | "company";
  readonly yaml: string;
}

/** `dist/worker.js` and `src/*.ts` both sit one level below the package root. */
export function bundledScenariosDir(moduleUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "scenarios");
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (/\.ya?ml$/.test(e.name)) out.push(full);
  }
  return out.sort();
}

export async function loadBundledScenarios(dir = bundledScenariosDir()): Promise<CatalogScenario[]> {
  const files = await walk(dir);
  return Promise.all(
    files.map(async (f) => {
      const yaml = await fs.readFile(f, "utf8");
      return { scenario: parseScenario(yaml, path.relative(dir, f)), source: "bundled" as const, yaml };
    }),
  );
}

/**
 * Bundled packs plus the company's own scenarios. A company scenario with the
 * same id overrides the bundled one; unparseable stored scenarios are skipped
 * and reported rather than failing the whole catalog.
 */
export async function loadScenarioCatalog(store: EvalStore, companyId: string, bundledDir?: string): Promise<{ scenarios: CatalogScenario[]; invalid: { scenarioId: string; error: string }[] }> {
  const byId = new Map<string, CatalogScenario>();
  for (const s of await loadBundledScenarios(bundledDir)) byId.set(s.scenario.id, s);
  const invalid: { scenarioId: string; error: string }[] = [];
  for (const row of await store.listCompanyScenarios(companyId)) {
    try {
      byId.set(row.scenario_id, { scenario: parseScenario(row.yaml, row.scenario_id), source: "company", yaml: row.yaml });
    } catch (err) {
      invalid.push({ scenarioId: row.scenario_id, error: err instanceof ScenarioParseError ? err.message : String(err) });
    }
  }
  return { scenarios: [...byId.values()].sort((a, b) => a.scenario.id.localeCompare(b.scenario.id)), invalid };
}
