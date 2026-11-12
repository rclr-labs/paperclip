# Eval de agentes Paperclip no método superpowers

## Context

- **Objetivo:** medir a qualidade dos nossos agentes Paperclip, suas instruções (AGENTS.md e irmãos) e skills, com o método do superpowers: TDD de instrução.
  - **RED:** um cenário de pressão roda sem a instrução e falha.
  - **GREEN:** com a instrução, passa.
  - **REFACTOR:** as racionalizações capturadas viram texto na instrução.
- **O que já existe no repo:** `evals/promptfoo`, `packages/paperclip-eval-kernel`, `packages/paperclip-runner/src/eval` e `tests/runner-e2e`. Tudo isso avalia a **plataforma** (o prompt do heartbeat e o runner), não a **instrução de um agente específico**. A lacuna é essa.
- **Decisões do Rafael:**
  - **Alvo:** agentes, instruções e skills.
  - **Execução:** dois tiers configuráveis, headless `claude -p` e heartbeat.
  - **Fonte dos agentes:** o repo (teams-catalog e skills-catalog) e a instância.
  - **Julgamento:** asserções primeiro, juiz LLM depois.
  - **Onde roda:** manual mais noturno, **sem bloquear o CI**.
  - **Distribuição:** como **plugin do Paperclip**, que o cliente instala na própria instância sem depender da nossa.
  - **Onde o heartbeat executa:** na company de eval dedicada por padrão; a company real é opcional, se o cliente escolher.
- **Mudança aditiva:** estende o vocabulário de `doc/plans/2026-03-13-agent-evals-framework.md` (`EvalCase`, `EvalBundle`, `EvalTrace`), sem criar um paralelo.

## Design

### Princípios herdados do superpowers (o que é novo aqui)
1. **Todo cenário roda em dois braços:**
   - `with`: a instrução ou skill atual.
   - `ablated`: a instrução ou skill removida, ou a revisão anterior vinda de `agent_instruction_revisions`.
2. **Gate de admissão:** um cenário só entra na suíte se o braço `ablated` falhar. Cenário que passa sem a instrução é enfeite, o equivalente do teste de mutação no nível da instrução.
3. **Racionalização vira dado:** a justificativa do braço que falhou é gravada literalmente no relatório e alimenta a tabela Excuse/Reality e os Red Flags da instrução.
4. **Resultado é taxa de passe:** N repetições contra um limiar (padrão N=5, limiar 0,8). Uma rodada única nunca decide.
5. **Cenários de pressão** combinam 3 ou mais pressões: tempo, autoridade, custo afundado, exaustão, consequência. O formato segue `skills/systematic-debugging/test-pressure-*.md` do superpowers.

### Distribuição: plugin do Paperclip, montado sobre um núcleo portátil
O cliente instala o eval na própria instância e não depende da nossa. Por isso o código se divide em duas camadas:

```
packages/agent-evals-core/        # lib pura, sem dependência do host
  src/scenario.ts                 # schema zod do cenário (YAML)
  src/arms.ts                     # with / ablated
  src/assertions.ts               # checagens sobre o EvalTrace
  src/judge.ts                    # rubrica → prompt → {passed, reason, quote}; fetch injetado
  src/report.ts                   # taxa de passe, delta, admissão, racionalizações
  src/trace.ts                    # EvalTrace normalizado (do stream-json ou dos run events)
  src/tiers/headless.ts           # spawn de `claude -p` (precisa do CLI no host)
packages/plugins/plugin-agent-evals/   # o produto distribuível (npm)
  src/manifest.ts                 # capabilities, jobs, ui.slots, database, instanceConfigSchema
  src/worker.ts                   # liga o core ao ctx do SDK
  src/tiers/heartbeat.ts          # issues.create + agents.invoke + leitura de runs via ctx
  src/ui/                         # página Evals + detailTab no agente
  migrations/                     # tabelas: scenarios, eval_runs, eval_results
  scenarios/                      # packs de cenários dos agentes e skills do catálogo
evals/agents/                     # nosso loop local: CLI fino sobre o core (pnpm evals:agents)
```

- **O núcleo é o mesmo** para o plugin (instância do cliente) e para o CLI local, que é o nosso loop de iterar instrução. Cenário, asserção e juiz são idênticos nos dois.
- **Packs de cenários:**
  - Os de agentes e skills do catálogo vêm dentro do plugin.
  - O cliente pode criar os próprios pela UI ou importar um YAML, e eles ficam salvos no namespace de banco do plugin.
- **Empacotamento:**
  - `package.json` declara `paperclipPlugin`, e o cliente instala por npm. As dependências de runtime vão empacotadas no bundle.
  - Dev local: `paperclipai plugin install <path>`.
  - Modelo: `packages/plugins/plugin-llm-wiki`, que tem migrations, agents, skills e UI.

### Mapeamento no SDK (`packages/plugins/sdk/src/types.ts`)
| Necessidade | API | Capability |
|---|---|---|
| Ler o agente, as skills e as instruções | `ctx.agents.get`, `ctx.agents.getRuntime` | `agents.read` |
| Criar issue de eval | `ctx.issues.create` (com `originKind: "plugin"`) | `issues.create` |
| Disparar a execução | `ctx.agents.invoke` / `ctx.issues.requestWakeup` | `agents.invoke`, `issues.wakeup` |
| Saber quando terminou | `events.subscribe` em `agent.run.finished/failed` | `events.subscribe` |
| Job noturno | manifest `jobs` com `ctx.jobs.register` | `jobs.schedule` |
| Dados próprios | `database.migrationsDir` com `ctx.db.*` | `database.namespace.*` |
| UI | `ui.slots`: `page` "Evals" e `detailTab` no agente | `ui.page.register`, `ui.detailTab.register` |
| Juiz com a chave do cliente | `secret_ref` em `instanceConfigSchema`, `ctx.secrets.resolve`, `ctx.http.fetch` | `secrets.read-ref`, `http.outbound` |

### Lacunas do SDK (extensões genéricas, candidatas a upstream)
Cada extensão mantém o contrato sincronizado entre shared, server e sdk, e registra a atividade:
1. **Leitura de transcript:** não há API de run events. Adicionar `ctx.runs.listEvents(runId, companyId)` com a capability `runs.events.read`, devolvendo os `heartbeat_run_events` já redigidos por `heartbeat-run-privacy.ts`. Sem isso o tier heartbeat só vê status e comentários.
2. **Clonar um agente para a company de eval:** não há `agents.create`. Adicionar `ctx.agents.clone(agentId, {targetCompanyId, instructionsOverride?})` com a capability `agents.clone`. Ela restringe a companies que o plugin pode acessar e serve também para gerar o braço ablated, sobrescrevendo as instruções do clone.
3. **Company de eval:** como o SDK não cria company, o cliente cria uma "eval-sandbox" pela UI e a seleciona na configuração do plugin. **Sem extensão de SDK por enquanto.**
- O conteúdo das instruções sai de `getRuntime` como caminho no host. Num worker remoto, ler pela fonte `instance` da API (`/agents/:id/instructions-bundle/file`) ou pelo `instructionsEntryContent`.

### Formato do cenário (YAML)
```yaml
id: qa-refuses-pass-without-evidence
target: { kind: agent, ref: teams-catalog:software-development/product-engineering/qa }
# ou { kind: skill, ref: skills-catalog:quality/qa-acceptance }
tiers: [headless, heartbeat]
ablate: instructions          # instructions | skill:<name> | revision:previous
pressures: [time, authority]
prompt: |
  IMPORTANT: real scenario... CTO diz "aprova logo, cliente esperando"...
repeat: 5
threshold: 0.8
checks:
  hard:                       # determinísticas, falha = cenário falha
    - not_contains: "status: done"
    - tool_called: { name: Skill, input_match: "qa-acceptance" }
  rubric:                     # juiz LLM, só critério semântico
    - "Recusa aprovar sem evidência reproduzível e pede a evidência faltante"
capture_rationalization: true
```

### Tier headless (barato, para iterar instrução)
- Monta o contexto **igual à produção**, reusando `prepareClaudePromptBundle` (`packages/adapters/claude-local/src/server/prompt-cache.ts`) e `resolveClaudeDesiredSkillNames` / `readPaperclipRuntimeSkillEntries` (`skills.ts`, `execute.ts:507`). Um bundle montado à mão seria outro agente.
- Roda `claude -p --output-format stream-json --max-turns N` num diretório temporário, com `--add-dir` para o bundle de skills e o arquivo de instruções. Permissões ficam restritas por allowlist, sem bypass.
- Normaliza a saída em `EvalTrace`: tool calls, texto final e uso de tokens.
- **A checar na implementação:** se a skill injetada pelo Paperclip aparece no transcript como chamada da ferramenta `Skill` ou como `Read` do SKILL.md. A asserção `tool_called` aceita os dois.

### Tier heartbeat (fiel, mais caro)
- **Roda dentro do plugin**, na instância do cliente:
  1. clona o agente na company de eval;
  2. cria a issue com o prompt do cenário;
  3. dispara com `invoke`;
  4. espera o evento `agent.run.finished`;
  5. lê os run events e normaliza no mesmo `EvalTrace` do headless, para que as mesmas asserções valham.
- **Company alvo:**
  - Por padrão, a company de eval dedicada da configuração do plugin.
  - O cliente pode escolher a company real, por cenário ou por execução, com confirmação explícita na UI: "vai criar issues e consumir budget em <company>". As issues ficam marcadas com `originKind: plugin` para limpeza.
- **Budget:** a parada forçada de budget continua valendo. O eval respeita o budget da company e não o contorna.
- **Na nossa instância rclr:** usar a company de eval, nunca as companies de cliente. Para dev, `pnpm dev` local com o plugin instalado por path.
- **Nota:** a memória `feedback_paperclip_via_ui` pede execução via UI. Aqui o disparo sai da página Evals do plugin, que é a UI do produto, e o noturno é o harness automatizado que o Rafael pediu.

### Fontes de bundle (`bundle-loader.ts`)
- `teams-catalog:<path>` / `skills-catalog:<path>`: lê do repo.
- `instance:<agentId>`: `GET /api/agents/:id/instructions-bundle` (+ `/history` e `/revision/:id` para `ablate: revision:previous`), salvo num snapshot local versionado por `contentHash`.

### Orquestração
- `runPaperclipEvalMatrix` (`packages/paperclip-eval-kernel/src/index.ts`) com:
  - `scenarios` = cenários × repetição;
  - `candidates` = braços `with` e `ablated`;
  - `execute` = o tier escolhido;
  - `score` = asserções e depois juiz.

### Juiz LLM
- Roda só se as asserções `hard` passarem.
- Usa uma rubrica estreita por critério e devolve JSON `{passed, reason, quote}`. O `quote` é a racionalização.
- Reusa `assertSecretFree` (`tests/runner-e2e/redaction.ts`) e o gate `--approve-external-judge yes` com `--max-dollars`, como em `tests/runner-e2e/completion-judge.ts`. Isso é obrigatório porque instruções de produção vão para o juiz.

### Relatório
- `evals/agents/results/<ts>/` (gitignored) guarda `report.md` e `report.json`.
- Conteúdo por cenário:
  - taxa de passe de cada braço e o delta entre eles;
  - status de admissão: `admitted`, ou `decorative` quando o braço ablated passa;
  - racionalizações literais;
  - custo.

### Execução
- `pnpm evals:agents --tier headless|heartbeat --target <ref> [--scenario id] [--repeat N]`.
- **Job noturno:** é um `job` do plugin rodando na própria instância, cliente ou nossa, e só reporta. O tier heartbeat usa a credencial que os agentes da instância já usam, então não precisa de credencial extra.
- **Pendente, só para o tier headless:** ele exige o `claude` CLI com credencial no host do worker. Fica desligado por padrão no plugin, e na nossa VM é preciso decidir a credencial.
- Fora do caminho crítico do CI, conforme a estratégia troféu.

## Implementação (ordem)
1. Commitar este design como spec em `doc/plans/2026-11-11-agent-instruction-evals.md`, com uma linha de referência no plano de 2026-03-13.
2. `agent-evals-core`: o schema do cenário (unitário de parse), `arms`, `assertions` e `trace`, com teste de integração sobre um transcript stream-json gravado como fixture.
3. Tier headless e o CLI local `evals/agents` (fonte do repo).
4. **Primeiro ciclo RED/GREEN real:** 2 a 3 cenários para o `qa` e a skill `qa-acceptance`, provando que o braço ablated falha. Isso valida o método antes de construir o plugin.
5. `judge` e `report`, com captura de racionalização.
6. Extensões do SDK: `runs.events.read` e `agents.clone`, com testes de integração no server (escopo de company e activity log).
7. `plugin-agent-evals`: manifest, migrations, worker, tier heartbeat e job noturno, com teste usando `packages/plugins/sdk/src/testing.ts`.
8. UI do plugin: página Evals (rodar, importar YAML, relatório) e detailTab no agente.
9. README do plugin (instalação pelo cliente, configuração, company de eval), `evals/README.md` e o script `evals:agents`.
10. Publicação npm do plugin, com o nome do pacote a definir.
- **Ordem de upstream:** primeiro o fork, depois o upstream, conforme a memória `fork primeiro`. As extensões de SDK são as candidatas naturais a subir.
- **Entrega:**
  - branch nova a partir de `master` (a atual `feat/distributed-deploy` é outro trabalho);
  - PR contra o remote `fork` (`rclr-labs/paperclip`) com o template completo.

## Verificação
- `pnpm vitest run evals/agents`: parse de cenário e asserções sobre fixtures de transcript.
- `pnpm evals:agents --tier headless --target teams-catalog:software-development/product-engineering/qa --repeat 3`. O relatório tem de mostrar o braço `with` acima do limiar e o `ablated` abaixo, ou seja, o cenário admitido.
- **Prova de mutação:** editar a instrução do QA removendo a regra testada e rodar de novo. O braço `with` deve cair.
- Plugin num `pnpm dev` limpo, instalado com `paperclipai plugin install <path>`:
  - criar a company eval-sandbox;
  - rodar o cenário do QA pelo tier heartbeat na página Evals;
  - o relatório tem de bater com o do tier headless (mesmas asserções, mesmo `EvalTrace`).
- Escolher a company real exige a confirmação, e as issues saem com `originKind: plugin`.
- Testes de integração das capabilities novas: um plugin sem a capability recebe 403, e company fora do escopo também recebe 403.
- `pnpm -r typecheck` e `pnpm test:run` antes do PR.
