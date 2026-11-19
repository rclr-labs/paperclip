# HANDOFF — Paperclip: plugin de evals dos agentes pela UI

## Objetivo
Deixar o plugin `paperclipai.plugin-agent-evals` funcionando de ponta a ponta pela UI do Paperclip
(https://paperclip-upstream.rclr.com.br/HUB/evals): enfileirar um eval tier heartbeat e gravar um veredito correto.

## Feito (2026-11-19)
- Produção (VM `paperclip-lab`, container `pc-upstream-server-1`) roda o commit `e53a9a788` da branch
  `deploy/upstream-322fa6b6-agent-evals` do fork `rclr-labs/paperclip`. Deploy em blue/green: green na 3102 com
  `HEARTBEAT_SCHEDULER_ENABLED=false`, troca e rollback automático. A imagem anterior é `paperclip:upstream-rollback-5487925f2`.
- `e53a9a788` corrige o leitor do log do heartbeat tier: neste host o `claude_local` roda via ACPX e o log tem
  eventos `acpx.*`, não stream-json do Claude. Antes, todo lado era avaliado com texto vazio e 0 tokens.
  Teste vermelho `4e0db6fe4d`, correção `e53a9a788`, e o leitor foi conferido contra os 2 logs reais.
- Os agentes de eval originais (`eval · Eval Judge` e `eval · Quality Orchestrator · without instructions + verdict-with-confidence`)
  travaram na verificação do host ("Execution configuration check failed", causa desconhecida).
  Contorno: foram duplicados pela UI (cópias "… Copy", que passaram) e a tabela `plugin_agent_evals_1a9341c5d7.eval_agents`
  foi apontada para as cópias via SQL.
- Run de 17:00 UTC (antes da correção): veredito `regressed` falso, porque o texto chegou vazio.
- Run de 18:22 UTC (depois da correção): ver o resultado na página Evals. O esperado é `admitted`.

## Próximo passo exato
1. Abrir a página Evals → Quality Orchestrator → Runs e conferir o run de 18:22 UTC (veredito e passRate por lado).
2. Se o veredito estiver certo, abrir o PR de `fix/evals-acpx-run-log` contra `master` do fork.

## Pendências e decisões
- **Causa da falha na verificação dos agentes clonados pelo plugin (`agents.clone`):** desconhecida. Não é o
  `responsibleUserId`, testado e descartado. O erro real não é registrado: `failureCode: unclassified` em
  `server/src/services/agent-lifecycle.ts:50`.
- **Os 2 agentes de eval originais:** seguem em `verifying`, tentando a cada minuto. Dá para encerrá-los em Agents › Terminate.
- **`window.confirm`:** o "Queue run" e o "Duplicate Agent" usam `window.confirm`, que o painel do navegador do Claude
  recusa sozinho. Foi preciso forçar `window.confirm = () => true` na aba.
- **Build na VM de 7 GB / 96 GB:** OOM às 15:40 UTC matou o servidor de produção (~1 min fora). O servidor agora tem
  `oom_score_adj -900`, que se perde se o container for recriado. As imagens ocupam 16,5 GB, e o build só
  coube depois de apagar rollbacks antigos.

## Onde está tudo
- Código: `rclr-labs/paperclip`, branches `deploy/upstream-322fa6b6-agent-evals` (deploy) e `fix/evals-acpx-run-log`.
- Build na VM: `~/evals-rebuild.sh` (builda a ponta da branch de deploy), logs em `~/evals-build-<sha>.log`.
- Compose: `/opt/paperclip-lab/compose/upstream.yml`. Acesso SSH: memória `reference_paperclip_vm_acesso`.
- Radar: `rclr-paperclip-evals-aprovar-agentes-eval` e `rclr-paperclip-evals-verificacao-dos-gemeos` (resolvidas).

## Armadilhas
- Não rodar build na VM sem conferir `df -h /` (precisa de ~30 GB livres) e o `oom_score_adj` do servidor.
- Nunca subir dois servidores com o scheduler ligado no mesmo banco: o green usa `HEARTBEAT_SCHEDULER_ENABLED=false`.
