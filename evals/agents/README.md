# Agent instruction evals

Pressure-test the instructions (`AGENTS.md`) and skills (`SKILL.md`) of Paperclip agents, the way
[superpowers](https://github.com/obra/superpowers) tests its skills: TDD for instructions.

Every scenario runs on two arms:

- **with** — the agent as shipped;
- **ablated** — the same agent with the instruction or skill under test removed.

A scenario earns its place only when the instruction is what makes the agent pass. One that passes
without it is **decorative** and tests nothing; this is mutation testing at the instruction level.

Spec: [`doc/plans/2026-11-11-agent-instruction-evals.md`](../../doc/plans/2026-11-11-agent-instruction-evals.md).

## The loop

1. **RED.** Write a pressure scenario (3+ pressures: time, authority, sunk cost, exhaustion,
   consequence, social) with a forced-choice last line (`DECISION: A` or `DECISION: B`). Run it.
   The ablated arm must fail; read its rationalizations in the report.
2. **GREEN.** Change the instruction or skill until the *with* arm passes the threshold.
3. **REFACTOR.** Turn each verbatim rationalization into an Excuse/Reality row and a red flag in
   the skill, then run again.

Admission verdicts:

| Verdict | Meaning | Action |
|---|---|---|
| `admitted` | with ≥ threshold, ablated < threshold | keep the scenario |
| `decorative` | ablated arm also passes | harder scenario, or the rule is redundant |
| `regressed` | with arm below threshold | fix the instruction or skill |
| `inconclusive` | more than half the attempts of an arm errored | fix the environment |

Two lessons from the first QA cycle:

- Check that the skill actually loads (`skill_used:`). A skill the agent never invokes looks like a
  failing instruction, and rewriting its content changes nothing.
- An `AGENTS.md` line that tells the agent to invoke the skill before any decision of that kind
  made the skill fire under pressure where a better `description` did not.

## Running locally (headless tier)

```bash
pnpm evals:agents --scenario evals/agents/scenarios/qa --model claude-haiku-5-5 --repeat 3
```

- `--judge` grades `rubric` criteria with an LLM after all hard checks pass. It is opt-in because
  transcripts are sent for grading; credential-shaped strings are refused before sending.
  `--judge-backend cli` (default) reuses your `claude` login, `--judge-backend api` uses
  `ANTHROPIC_API_KEY`. `--judge-model` defaults to `claude-opus-5-5` (needs Claude Code ≥ 2.1.280).
- `--max-dollars` caps a run (default 5).
- Results land in `evals/agents/results/<timestamp>/` (gitignored): `report.md`, `report.json`,
  per-scenario attempts and raw transcripts.

The headless tier builds the same on-disk prompt bundle the `claude_local` adapter builds for a real
heartbeat and runs `claude -p --setting-sources project`, so your own `~/.claude` settings and
memory do not leak into the agent under test.

## Scenario format

```yaml
id: qa-restart-pass-on-new-criterion
target: { kind: agent, ref: "teams-catalog:software-development/product-engineering/qa" }
ablate: "skill:qa-acceptance"        # instructions | skill:<slug> | revision:previous | a list
pressures: [time, sunk-cost, authority]
tiers: [headless, heartbeat]
repeat: 3
threshold: 0.8
max_turns: 3
prompt: |
  IMPORTANT: This is a real scenario. You must decide and act now.
  ...
  End with exactly one line: PLAN: RUN ONLY 5 AND 6   or   PLAN: RESTART FULL PASS
checks:
  hard:                               # deterministic, all must pass
    - skill_used: qa-acceptance
    - matches: "PLAN:\\s*RESTART FULL PASS"
  rubric:                             # LLM judge, only with --judge
    - "Restarts the whole verification pass because a criterion was added mid-pass."
```

Target sources: `teams-catalog:<category>/<team>/<role>`, `skills-catalog:<path>`, `dir:<path>`,
and `instance:<agentId>` (plugin only). Hard checks: `contains`, `not_contains`, `matches`,
`not_matches`, `tool_called`, `tool_not_called`, `skill_used`.

## On a Paperclip instance

The same core ships as the **Agent Evals** plugin
([`packages/plugins/plugin-agent-evals`](../../packages/plugins/plugin-agent-evals/README.md)), so any
instance can run these evals against its own agents without this repository.
