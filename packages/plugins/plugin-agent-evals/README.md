# Agent Evals plugin

Run instruction-level evals against the agents of your own Paperclip instance. Each scenario runs
with the instruction or skill under test and without it; only scenarios the instruction makes pass
are kept. Method and scenario format: [`evals/agents/README.md`](../../../evals/agents/README.md).

## Install

```bash
pnpm --filter @paperclipai/plugin-agent-evals build
npx paperclipai plugin install /absolute/path/to/packages/plugins/plugin-agent-evals
```

Published builds install from npm like any other plugin.

## Configure

| Setting | Default | Notes |
|---|---|---|
| Eval company | none | Create a dedicated company (for example `eval-sandbox`) and select it. The heartbeat tier clones agents and creates issues there, never in your real companies. |
| Allow running in the agent's own company | off | When on, a run can target the real company after an explicit confirmation in the UI. Budgets and approval gates still apply. |
| Enable headless tier | off | Runs `claude -p` on the worker host; needs the Claude CLI and a credential there. |
| Anthropic API key for the judge | none | Secret reference. Without it only deterministic checks decide. Judge traffic goes through the host's outbound HTTP client. |
| Judge model | `claude-opus-5-5` | |
| Budget per eval run | 5 USD | The run stops starting new attempts once it is reached. |

## Use

- **Evals page**: pick an agent, choose scenarios and a tier, queue a run, import your own scenarios
  as YAML.
- **Agent → Evals tab**: the same panel for one agent.
- Runs are queued and picked up by the `run-queued-evals` job (every 5 minutes). A cross-company
  clone is only admitted from a proactive call, which is why the UI queues instead of running inline.
- The `nightly-regression` job re-queues each agent's latest run at 03:00 and only reports.

Results show, per scenario, the pass rate with and without the instruction, the admission verdict
and the agent's verbatim rationalizations.

## Tiers

- **Heartbeat**: clones the agent into the eval company (the ablated arm with its instruction entry
  blanked), invokes the clone with the scenario prompt, waits for `agent.run.finished`, and rebuilds
  the trace from the run's events. Requires the host to expose the plugin capabilities
  `agents.clone` and `runs.events.read`; until it does, the UI shows the tier as unavailable. Skill
  ablation is not expressible through `agents.clone` yet, so `skill:` scenarios run headless only.
- **Headless**: `claude -p` with the agent's instructions and skills read from the host, mirroring
  the `claude_local` adapter's prompt bundle.

## Data

Three tables in the plugin's database namespace (`migrations/001_agent_evals.sql`): imported
scenarios, eval runs, and per-scenario results. Every mutation writes an activity log entry.
