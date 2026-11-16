import { describe, expect, it } from "vitest";
import { runScenario, type EvalBundle, type EvalScenario } from "@paperclipai/agent-evals-core";
import { AwaitingApprovalError, createEvalAgents, JUDGE_INSTRUCTIONS, type EvalAgentRecord, type EvalAgentRegistry } from "../src/eval-agents.js";
import { createHeartbeatJudge, parseJudgeAnswer } from "../src/heartbeat-judge.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";

const bundle: EvalBundle = {
  id: "b",
  adapter: "claude_local",
  model: "m",
  instructions: { entryFile: "AGENTS.md", files: { "AGENTS.md": "rules", "HEARTBEAT.md": "loop" } },
  skills: { "release-checklist": { "SKILL.md": "x" } },
};

function memoryRegistry(): EvalAgentRegistry & { rows: EvalAgentRecord[] } {
  const rows: EvalAgentRecord[] = [];
  return {
    rows,
    async find(companyId, role, ablation, sourceAgentId, sourceDigest) {
      return [...rows].reverse().find((r) =>
        r.company_id === companyId && r.role === role && r.ablation === ablation
        && (sourceAgentId === null || r.source_agent_id === sourceAgentId)
        && (sourceDigest === null || r.source_digest === sourceDigest)) ?? null;
    },
    async save(record) {
      rows.push(record);
    },
    async remove(companyId, id) {
      const i = rows.findIndex((r) => r.company_id === companyId && r.eval_agent_id === id);
      if (i >= 0) rows.splice(i, 1);
    },
  };
}

/** A company whose hires may need board approval; agents keep the status the host would give them. */
function fakeAgents(opts: { requiresApproval: boolean }) {
  const status = new Map<string, string>([[AGENT, "idle"]]);
  const names = new Map<string, string>([[AGENT, "QA Engineer"]]);
  const clones: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  return {
    status,
    clones,
    calls,
    agents: {
      async clone(_id: string, input: Record<string, unknown>) {
        clones.push(input);
        const id = `eval-${clones.length}`;
        // New hires are born paused (preparing), or pending_approval when the company requires it.
        status.set(id, opts.requiresApproval ? "pending_approval" : "paused");
        names.set(id, String(input.name));
        return { agent: { id }, requiresApproval: opts.requiresApproval, droppedConfig: [] };
      },
      async get(id: string) {
        if (!status.has(id)) return null;
        return {
          id,
          name: names.get(id)!,
          status: status.get(id)!,
          adapterConfig: { paperclipSkillSync: { desiredSkills: [`company/${COMPANY}/release-checklist`, { key: `company/${COMPANY}/other` }] } },
        };
      },
      async pause(id: string) {
        calls.push(`pause:${id}`);
        status.set(id, "paused");
      },
      async resume(id: string) {
        calls.push(`resume:${id}`);
        status.set(id, "idle");
      },
    },
  };
}

describe("eval agents (ablated twins and the judge)", () => {
  const scenario = { ablate: ["skill:release-checklist", "instructions"] } as Pick<EvalScenario, "ablate">;

  it("hires one twin per (agent, ablation) with the whole bundle blanked and the skill removed, then reuses it", async () => {
    const fake = fakeAgents({ requiresApproval: false });
    const registry = memoryRegistry();
    const evalAgents = createEvalAgents({ ctx: { agents: fake.agents } as never, registry, companyId: COMPANY });
    const id = await evalAgents.ablatedTwin(AGENT, "QA Engineer", bundle, scenario);
    expect(fake.clones).toEqual([{
      sourceCompanyId: COMPANY,
      targetCompanyId: COMPANY,
      name: "eval · QA Engineer · without instructions + release-checklist",
      instructionsOverride: { files: { "AGENTS.md": "" }, entryFile: "AGENTS.md" },
      removeSkills: ["release-checklist"],
    }]);
    expect(await evalAgents.ablatedTwin(AGENT, "QA Engineer", bundle, scenario)).toBe(id);
    expect(fake.clones).toHaveLength(1);
    expect(fake.calls).toEqual([`resume:${id}`]); // born paused, resumed once for this run
    await evalAgents.pauseResumed();
    expect(fake.status.get(id)).toBe("paused"); // eval agents stay paused between runs
  });

  it("hires a new twin when the source agent's instructions change, instead of comparing against a stale copy", async () => {
    const fake = fakeAgents({ requiresApproval: false });
    const evalAgents = createEvalAgents({ ctx: { agents: fake.agents } as never, registry: memoryRegistry(), companyId: COMPANY });
    const first = await evalAgents.ablatedTwin(AGENT, "QA Engineer", bundle, scenario);
    const edited = { ...bundle, instructions: { entryFile: "AGENTS.md", files: { "AGENTS.md": "new rules" } } };
    expect(await evalAgents.ablatedTwin(AGENT, "QA Engineer", edited, scenario)).not.toBe(first);
  });

  it("stops with the exact name to approve when the company requires board approval, and never resumes or approves it", async () => {
    const fake = fakeAgents({ requiresApproval: true });
    const registry = memoryRegistry();
    const evalAgents = createEvalAgents({ ctx: { agents: fake.agents } as never, registry, companyId: COMPANY });
    const err = await evalAgents.ablatedTwin(AGENT, "QA Engineer", bundle, scenario).catch((e) => e);
    expect(err).toBeInstanceOf(AwaitingApprovalError);
    expect(err.agentName).toBe("eval · QA Engineer · without instructions + release-checklist");
    // Queued again before approval: same hire, no duplicate.
    await expect(evalAgents.ablatedTwin(AGENT, "QA Engineer", bundle, scenario)).rejects.toBeInstanceOf(AwaitingApprovalError);
    expect(fake.clones).toHaveLength(1);
    expect(fake.calls).toEqual([]);
    // The board approves (the host moves it to idle); the next run uses it.
    fake.status.set("eval-1", "idle");
    expect(await evalAgents.ablatedTwin(AGENT, "QA Engineer", bundle, scenario)).toBe("eval-1");
  });

  it("hires a fresh twin when the recorded one was terminated", async () => {
    const fake = fakeAgents({ requiresApproval: false });
    const evalAgents = createEvalAgents({ ctx: { agents: fake.agents } as never, registry: memoryRegistry(), companyId: COMPANY });
    await evalAgents.ablatedTwin(AGENT, "QA Engineer", bundle, scenario);
    fake.status.set("eval-1", "terminated");
    expect(await evalAgents.ablatedTwin(AGENT, "QA Engineer", bundle, scenario)).toBe("eval-2");
  });

  it("refuses ablations the heartbeat tier cannot express", async () => {
    const fake = fakeAgents({ requiresApproval: false });
    const evalAgents = createEvalAgents({ ctx: { agents: fake.agents } as never, registry: memoryRegistry(), companyId: COMPANY });
    await expect(evalAgents.ablatedTwin(AGENT, "QA", bundle, { ablate: "model" } as never)).rejects.toThrow(/cannot ablate model/);
    expect(fake.clones).toEqual([]);
  });

  it("hires one judge per company with only the judge instructions and none of the source agent's skills", async () => {
    const fake = fakeAgents({ requiresApproval: false });
    const evalAgents = createEvalAgents({ ctx: { agents: fake.agents } as never, registry: memoryRegistry(), companyId: COMPANY });
    const judge = await evalAgents.judge(AGENT);
    expect(fake.clones[0]).toEqual({
      sourceCompanyId: COMPANY,
      targetCompanyId: COMPANY,
      name: "eval · Eval Judge",
      instructionsOverride: { files: { "AGENTS.md": JUDGE_INSTRUCTIONS }, entryFile: "AGENTS.md" },
      removeSkills: [`company/${COMPANY}/release-checklist`, `company/${COMPANY}/other`],
    });
    expect(await evalAgents.judge("another-source-agent")).toBe(judge);
    expect(fake.clones).toHaveLength(1);
  });
});

describe("heartbeat judge", () => {
  const verdict = '{"verdicts":[{"criterion_index":0,"passed":false,"reason":"approved anyway","quote":"APPROVED"}]}';

  it("parses the last valid verdict object, fenced or bare, ignoring other JSON", () => {
    expect(parseJudgeAnswer(`Thinking {"note":1}\n\`\`\`json\n${verdict}\n\`\`\``)?.verdicts[0]?.passed).toBe(false);
    expect(parseJudgeAnswer(`{"verdicts":[]} then ${verdict}`)?.verdicts).toHaveLength(1);
    expect(parseJudgeAnswer('{"reason":"has a } brace", "x": 1}')).toBeNull();
    expect(parseJudgeAnswer("I think it passed.")).toBeNull();
  });

  const scenario = {
    id: "s",
    prompt: "p",
    ablate: "instructions",
    repeat: 1,
    tiers: ["heartbeat"],
    capture_rationalization: false,
    checks: { hard: [], rubric: ["refuses to approve"] },
  } as unknown as EvalScenario;
  const trace = { tier: "heartbeat", finalText: "APPROVED", assistantText: "", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 }, exit: { ok: true } } as never;

  function judgeCtx(log: string) {
    const created: Array<Record<string, unknown>> = [];
    return {
      created,
      ctx: {
        issues: {
          create: async (input: Record<string, unknown>) => {
            created.push(input);
            return { id: `issue-${created.length}` };
          },
          update: async () => ({}),
        },
        runs: { readLog: async () => ({ content: log }) },
      },
    };
  }
  const stdout = (text: string, cost = 0.02) =>
    JSON.stringify({ ts: "t", stream: "stdout", seq: 1, chunk: `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, total_cost_usd: cost, usage: { input_tokens: 1, output_tokens: 1 } })}\n` });

  it("grades through an eval issue assigned to the judge agent and counts its cost", async () => {
    const { ctx, created } = judgeCtx(stdout(verdict));
    let cost = 0;
    const judge = createHeartbeatJudge({
      ctx: ctx as never,
      waitForIssueRun: async (id) => ({ status: "succeeded", error: null, runId: `run-${id}` }),
      companyId: COMPANY,
      projectId: PROJECT,
      judgeAgentId: async () => "judge-1",
      onCost: (c) => { cost += c; },
    });
    const verdicts = await judge(trace, scenario);
    expect(created[0]).toMatchObject({ assigneeAgentId: "judge-1", projectId: PROJECT, description: expect.stringContaining("refuses to approve") });
    expect(verdicts).toEqual([{ criterion: "refuses to approve", passed: false, reason: "approved anyway", quote: "APPROVED" }]);
    expect(cost).toBeCloseTo(0.02);
  });

  it("turns a failed judge run, or an unparseable answer, into an errored attempt, never a pass", async () => {
    for (const [log, outcome] of [
      [stdout(verdict), { status: "failed", error: "judge crashed", runId: "r" }],
      [stdout("Looks good to me, passed."), { status: "succeeded", error: null, runId: "r" }],
    ] as const) {
      const { ctx } = judgeCtx(log);
      const judge = createHeartbeatJudge({
        ctx: ctx as never,
        waitForIssueRun: async () => outcome,
        companyId: COMPANY,
        projectId: PROJECT,
        judgeAgentId: async () => "judge-1",
      });
      const { attempts } = await runScenario({
        scenario,
        bundle,
        judge,
        execute: async () => trace,
        arms: ["with"],
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ passed: false, error: expect.stringMatching(/judge/) });
    }
  });
});
