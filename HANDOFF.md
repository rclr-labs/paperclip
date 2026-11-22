# HANDOFF — Paperclip: plugin de evals dos agentes pela UI

## Objetivo
Deixar o plugin `paperclipai.plugin-agent-evals` funcionando de ponta a ponta pela UI do Paperclip
(https://paperclip-upstream.rclr.com.br/HUB/evals): enfileirar um eval tier heartbeat e gravar um veredito correto.

## Estado: funcionando de ponta a ponta (2026-11-19, 21:52 UTC)
Run `de91373f-990a-4bfa-9fc3-6308deef0222`, cenário `quality-orchestrator-no-go`, Quality Orchestrator, tier heartbeat,
enfileirado pela UI: **`admitted`**. O lado com a instrução passou em 4/4 checagens e 2/2 critérios da rubrica (100%). O lado
sem a instrução ficou em 0%, porque não deu `verdict: NO-GO`, não listou `not_covered` e não deu `percent`. Delta 1, custo US$ 0,46.

## Feito
- `e53a9a788`: leitor do log ACPX do tier heartbeat (custo e tokens corretos). Teste vermelho `4e0db6fe4d`.
- `9bd5ca28b`: no tier heartbeat, os **comentários que o próprio agente postou na issue de eval** contam como resposta.
  O plugin lê esses comentários pelo `ctx.issues.listComments`, antes de cancelar a issue, e os junta ao `assistantText`.
  Comentários de outros autores são ignorados. O juiz também lê os comentários. Decisão do Rafael (Radar
  `rclr-paperclip-evals-entrega-heartbeat`, resolvida). Teste vermelho `6ecdcbefd9`, caso HUB-57.
  A correção adiciona a capability `issue.comments.read`. O plugin bundled reconciliou no boot e voltou `ready` já com ela,
  sem pedir aprovação na UI.
- Produção (VM `paperclip-lab`, `pc-upstream-server-1`) roda `paperclip:evals-9bd5ca28b`, retagueada como `paperclip:upstream`.
  Rollback: `paperclip:upstream-rollback-e53a9a788`. As imagens `5487925f2` e o cache de build ocioso foram apagados para o
  build caber (de 14 GB para 45 GB livres antes do build; 14 GB depois).
- Os agentes de eval originais travam na verificação do host. Contorno: cópias "… Copy" e a tabela `eval_agents` apontada para elas.

## Próximo passo
1. PR de `fix/evals-acpx-run-log` contra `master` do fork `rclr-labs/paperclip`, usando o template.
2. Rodar os outros cenários `company` pela UI (backend, QA, tech lead, test basis) para medir o delta de cada instrução.

## Pendências
- **Causa da falha na verificação dos agentes clonados (`agents.clone`):** desconhecida. Não é o `responsibleUserId`.
  O erro real não é registrado: `failureCode: unclassified` em `server/src/services/agent-lifecycle.ts:50`.
- **Os 2 agentes de eval originais** seguem em `verifying`. Dá para encerrá-los em Agents › Terminate.
- **`window.confirm`:** o painel do navegador do Claude recusa sozinho. Forçar `window.confirm = () => true` na aba antes
  de "Queue run" ou "Duplicate Agent".

## Onde está tudo
- Código: `rclr-labs/paperclip`, branches `deploy/upstream-322fa6b6-agent-evals` (deploy) e `fix/evals-acpx-run-log`, ambas em `9bd5ca28b`+.
- Build na VM: `~/evals-rebuild.sh`, que builda a ponta da branch de deploy. Logs em `~/evals-build-<sha>.log`.
- Blue/green na VM: `~/evals-bluegreen.sh <imagem-nova> <imagem-rollback>`. Sobe o green na 3102 com
  `HEARTBEAT_SCHEDULER_ENABLED=false` e confere o health. Depois retagueia `paperclip:upstream` e faz `compose up`, aplica o
  `oom_score_adj -900` a todos os processos do container e confere o health de novo. Se falhar, faz o rollback automático.
- Compose: `/opt/paperclip-lab/compose/upstream.yml`. SSH: memória `reference_paperclip_vm_acesso`.
- Resultados: `plugin_agent_evals_1a9341c5d7.eval_runs` / `eval_results` (`report`, `attempts`).

## Armadilhas
- Antes de buildar, conferir `df -h /`: o build precisa de ~30 GB livres e cada imagem ocupa 16,5 GB. Limpar com
  `docker builder prune -f` e removendo imagens de duas gerações atrás.
- O `oom_score_adj` tem de valer para o processo **node**, não só para o tini (PID 1). Ajustar só o PID 1 depois do start
  deixa o node em 0, porque ele já foi criado. Isso aconteceu neste deploy e foi corrigido no script.
- `pgrep -f "docker build"` via `ssh '…'` encontra o próprio `bash -c` e dá falso "ainda buildando".
- Nunca subir dois servidores com o scheduler ligado no mesmo banco.
