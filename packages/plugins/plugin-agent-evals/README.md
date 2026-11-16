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
| Enable headless tier | off | Runs `claude -p` on the worker host; needs the Claude CLI and a credential there. |
| Anthropic API key for the judge | none | Secret reference. Without it only deterministic checks decide. Judge traffic goes through the host's outbound HTTP client. |
| Judge model | `claude-opus-5-5` | |
| Budget per eval run | 5 USD | The run stops starting new attempts once it is reached. |

To keep the plugin to some companies only, disable it for the others in each company's plugin settings.

## Use

- **Evals page**: pick an agent, choose scenarios and a tier, queue a run, import your own scenarios
  as YAML.
- **Agent → Evals tab**: the same panel for one agent.
- Runs are queued and picked up by the `run-queued-evals` job (every 5 minutes).
- The `nightly-regression` job re-queues each agent's latest run at 03:00 and only reports.

Results show, per scenario, the pass rate with and without the instruction, the admission verdict
and the agent's verbatim rationalizations.

## Tiers

- **Heartbeat**: runs on the agent itself, in its own company. Every attempt is an eval issue in
  the plugin-managed **Evals** project:
  - the *with* arm is assigned to the agent;
  - the *ablated* arm is assigned to a clone of the agent with its instruction entry blanked. An
    issue-level adapter override cannot blank instructions, because the host re-materializes the
    agent's bundle for every run.

  The plugin waits for the issue's `agent.run.*` event, rebuilds the trace from the run log
  (`runs.readLog`), and cancels the issue. Runs spend the agent's budget, so queueing one asks for
  confirmation. When the company requires board approval for new agents, approve the clone and
  queue again. Skill ablation is not expressible through `agents.clone` yet, so `skill:` scenarios
  run headless only.
- **Headless**: `claude -p` with the agent's instructions and skills read from the host, mirroring
  the `claude_local` adapter's prompt bundle.

## Data

Three tables in the plugin's database namespace (`migrations/001_agent_evals.sql`): imported
scenarios, eval runs, and per-scenario results. Every mutation writes an activity log entry.
