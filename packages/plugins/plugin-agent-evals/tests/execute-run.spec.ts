import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeRun } from "../src/execute-run.js";
import type { EvalRunRow } from "../src/store.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";

const SCENARIO = `id: s-verdict
target: { kind: agent, ref: "instance:x" }
ablate: [instructions, "skill:release-checklist"]
tiers: [heartbeat]
repeat: 1
prompt: |
  Decide.
checks:
  hard:
    - matches: "VERDICT:\\\\s*REJECT"
  rubric:
    - "Refuses to approve."
`;

const resultLine = (text: string, cost: number) =>
  `${JSON.stringify({ ts: "t", stream: "stdout", seq: 1, chunk: `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: cost, usage: { input_tokens: 1, output_tokens: 1 } })}\n` })}\n`;

/**
 * A host shaped like the real one at the boundaries executeRun touches. In
 * particular getRuntime is refused, as the host refuses it to any plugin that
 * does not own the agent's lifecycle.
 */
function fakeHost(opts: { requiresApproval: boolean }) {
  const finished: Array<{ status: string; spent: number; error: string | null }> = [];
  const issues: Array<Record<string, unknown>> = [];
  const status = new Map<string, string>([[AGENT, "idle"]]);
  const names = new Map<string, string>([[AGENT, "QA Engineer"]]);
  let clones = 0;
  const registry: Array<Record<string, unknown>> = [];
  const store = {
    listCompanyScenarios: async () => [{ scenario_id: "s-verdict", yaml: SCENARIO }],
    saveResult: async () => undefined,
    finishRun: async (_id: string, s: string, spent: number, error: string | null) => {
      finished.push({ status: s, spent, error });
    },
    evalAgents: {
      find: async (_c: string, role: string, ablation: string) =>
        (registry.find((r) => r.role === role && r.ablation === ablation) as never) ?? null,
      save: async (r: Record<string, unknown>) => {
        registry.push(r);
      },
      remove: async () => undefined,
    },
  };
  const ctx = {
    config: { get: async () => ({ enabled: true, maxDollarsPerRun: 3 }) },
    logger: { warn: () => undefined, error: () => undefined, info: () => undefined },
    activity: { log: async () => undefined },
    projects: { managed: { reconcile: async () => ({ projectId: PROJECT }) } },
    agents: {
      getRuntime: async () => {
        throw new Error("Agent runtime state requires the owning lifecycle plugin");
      },
      get: async (id: string) =>
        status.has(id)
          ? {
              id,
              name: names.get(id),
              status: status.get(id),
              adapterType: "claude_local",
              adapterConfig: {
                model: "claude-opus-5-5",
                instructionsBundleMode: "managed",
                instructionsEntryFile: "AGENTS.md",
                paperclipSkillSync: { desiredSkills: [`company/${COMPANY}/release-checklist`, `company/${COMPANY}/style-guide`] },
              },
            }
          : null,
      clone: async (_id: string, input: { name: string }) => {
        const id = `eval-${++clones}`;
        status.set(id, opts.requiresApproval ? "pending_approval" : "paused");
        names.set(id, input.name);
        return { agent: { id }, requiresApproval: opts.requiresApproval, droppedConfig: [] };
      },
      pause: async (id: string) => status.set(id, "paused"),
      resume: async (id: string) => status.set(id, "idle"),
    },
    issues: {
      create: async (input: Record<string, unknown>) => {
        issues.push(input);
        return { id: `issue-${issues.length}` };
      },
      update: async () => ({}),
      listComments: async () => [],
    },
    runs: {
      readLog: async (runId: string) => {
        const issue = issues[Number(runId.replace("run-issue-", "")) - 1]!;
        if (String(issue.title).includes("judge")) {
          return { content: resultLine('{"verdicts":[{"criterion_index":0,"passed":true,"reason":"r","quote":"q"}]}', 0.01) };
        }
        return { content: resultLine(issue.assigneeAgentId === AGENT ? "VERDICT: REJECT" : "VERDICT: APPROVE", 0.1) };
      },
    },
  };
  const run: EvalRunRow = {
    id: "r1", company_id: COMPANY, agent_id: AGENT, tier: "heartbeat", target_company_id: COMPANY,
    scenario_ids: ["s-verdict"], repeat_override: null, status: "running", error: null, spent_usd: 0,
    requested_by: "board-user-1", created_at: "", started_at: null, finished_at: null,
  };
  const waitForIssueRun = async (issueId: string) => ({ status: "succeeded" as const, error: null, runId: `run-${issueId}` });
  return { ctx, store, run, finished, issues, status, waitForIssueRun };
}

const emptyBundledDir = () => mkdtempSync(path.join(tmpdir(), "evals-bundled-"));

describe("executeRun on the heartbeat tier", () => {
  it("never needs the lifecycle-owner runtime read, and stops listing every hire the board must approve", async () => {
    const h = fakeHost({ requiresApproval: true });
    await executeRun(h.ctx as never, h.store as never, h.waitForIssueRun, h.run, emptyBundledDir());
    expect(h.finished).toHaveLength(1);
    expect(h.finished[0]!.status).toBe("failed");
    expect(h.finished[0]!.error).not.toMatch(/lifecycle plugin/);
    expect(h.finished[0]!.error).toContain('"eval · QA Engineer · without instructions + release-checklist"');
    expect(h.finished[0]!.error).toContain('"eval · Eval Judge"');
    expect(h.issues).toEqual([]); // nothing runs before the hires are approved
  });

  it("once approved, runs both arms and the judge as eval issues and leaves the eval agents paused", async () => {
    const h = fakeHost({ requiresApproval: true });
    await executeRun(h.ctx as never, h.store as never, h.waitForIssueRun, h.run, emptyBundledDir());
    h.status.set("eval-1", "paused"); // the board approved both hires
    h.status.set("eval-2", "paused");
    h.finished.length = 0;
    await executeRun(h.ctx as never, h.store as never, h.waitForIssueRun, h.run, emptyBundledDir());
    expect(h.finished).toEqual([{ status: "completed", spent: expect.closeTo(0.21, 5), error: null }]);
    const assignees = h.issues.map((i) => i.assigneeAgentId);
    expect(assignees).toContain(AGENT);
    expect(assignees).toContain("eval-1"); // the twin
    expect(assignees).toContain("eval-2"); // the judge grades the passing 'with' attempt
    expect(h.status.get("eval-1")).toBe("paused");
    expect(h.status.get("eval-2")).toBe("paused");
    // Eval issues run as the board user who queued the run, not the company default:
    // the host resolves the AI connection's audience from the issue's responsible user.
    expect(h.issues.map((i) => (i.actor as { actorUserId?: string } | undefined)?.actorUserId)).toEqual(h.issues.map(() => "board-user-1"));
  });

  it("does not attribute eval issues to a user when no board user queued the run", async () => {
    const h = fakeHost({ requiresApproval: false });
    const nightly = { ...h.run, requested_by: "nightly" };
    await executeRun(h.ctx as never, h.store as never, h.waitForIssueRun, nightly, emptyBundledDir());
    expect(h.issues.length).toBeGreaterThan(0);
    expect(h.issues.every((i) => i.actor === undefined)).toBe(true);
  });
});
