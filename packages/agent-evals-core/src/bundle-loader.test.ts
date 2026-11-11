import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAgentBundleFromDir, loadSkillBundle } from "./bundle-loader.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const skillRoots = [path.join(repo, "packages/skills-catalog/catalog/bundled"), path.join(repo, "skills")];

describe("bundle loader (real catalog)", () => {
  it("loads the product-engineering QA agent with its declared skill", async () => {
    const b = await loadAgentBundleFromDir({
      id: "qa",
      agentDir: path.join(repo, "packages/teams-catalog/catalog/bundled/software-development/product-engineering/agents/qa"),
      skillRoots,
    });
    expect(b.instructions?.files["AGENTS.md"]).toMatch(/^You are the QA Engineer/);
    expect(Object.keys(b.skills)).toEqual(["qa-acceptance"]);
    expect(b.skills["qa-acceptance"]["SKILL.md"]).toMatch(/name: qa-acceptance/);
  });

  it("loads a standalone skill and fails on unknown slugs", async () => {
    const b = await loadSkillBundle({ id: "s", slug: "qa-acceptance", skillRoots });
    expect(b.instructions).toBeNull();
    await expect(loadSkillBundle({ id: "s", slug: "does-not-exist", skillRoots })).rejects.toThrow(/not found/);
  });
});
