import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DotPairing } from "@paperclipai/shared";
import { grokBotApi } from "@/api/grokBot";
import { buildGrokAccessPrompt, buildGrokRoutinePrompt } from "@/lib/grok-bot-setup-prompt";
import { AgentSetupPrompt } from "./AgentSetupPrompt";
import { CopyText } from "./CopyText";
import { Button, buttonVariants } from "./ui/button";
import { Input } from "./ui/input";
import { queryKeys } from "@/lib/queryKeys";
import { useTranslation } from "@/i18n";

/** Configuration writes update the authoritative binding, never an unsaved agent form. */
export function GrokBotConnection({ companyId, agentId }: { companyId?: string; agentId?: string }) {
  const { t } = useTranslation();
  const pairingCodeId = useId();
  const cache = useQueryClient();
  const key = ["grok-binding", companyId, agentId];
  const state = useQuery({ queryKey: key, enabled: !!companyId && !!agentId,
    queryFn: ({ signal }) => grokBotApi.connection(companyId!, agentId!, signal), retry: false, refetchInterval: 5000 });
  const [pairing, setPairing] = useState<DotPairing | null>(null);
  const [replace, setReplace] = useState(false);
  const [botName, setBotName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookKey, setWebhookKey] = useState("");
  const [inspected, setInspected] = useState(false);
  const verifyRequest = useRef<string | null>(null);
  const binding = state.data?.binding, routine = binding?.routine, exchange = routine?.lastExchange;
  const refresh = async () => {
    await cache.invalidateQueries({ queryKey: key });
    if (companyId && agentId) await cache.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
  };
  const pair = useMutation({ mutationFn: async () => { setPairing(await grokBotApi.pair(companyId!, agentId!, binding?.status === "pairing" ? binding.id : undefined)); }, onSuccess: refresh, gcTime: 0 });
  const configure = useMutation({ mutationFn: async () => {
    await grokBotApi.configure(companyId!, agentId!, { bindingId: binding!.id, expectedRevision: routine?.revision ?? 0, botName, webhookUrl, webhookKey });
    setWebhookUrl(""); setWebhookKey(""); setReplace(false); verifyRequest.current = null;
  }, onSuccess: refresh, gcTime: 0 });
  const verify = useMutation({ mutationFn: async () => {
    if (["rejected", "cancelled"].includes(exchange?.status ?? "")) verifyRequest.current = null;
    verifyRequest.current ??= crypto.randomUUID();
    await grokBotApi.verify(companyId!, agentId!, binding!.id, verifyRequest.current);
  }, onSuccess: refresh, gcTime: 0 });
  const retryDelivery = useMutation({ mutationFn: (correlationId: string) => grokBotApi.retry(companyId!, agentId!, correlationId), onSuccess: refresh });
  const disconnect = useMutation({ mutationFn: () => grokBotApi.disconnect(companyId!, agentId!), onSuccess: async () => { setPairing(null); await refresh(); } });
  const recover = useMutation({ mutationFn: () => grokBotApi.recover(companyId!, agentId!), onSuccess: async () => { setInspected(false); verifyRequest.current = null; await refresh(); } });
  const stop = useMutation({ mutationFn: (runId: string) => grokBotApi.stop(companyId!, agentId!, runId), onSuccess: refresh });
  useEffect(() => { if (routine?.botName) setBotName(routine.botName); }, [routine?.botName]);
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setTimeout(() => setPairing(null), Math.max(0, Date.parse(pairing.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pairing]);
  if (!agentId) return <p className="text-sm text-muted-foreground">{t("components.grokBotConnection.saveTheGrokBotAgentBefore")}</p>;
  const busy = pair.isPending || configure.isPending || verify.isPending || disconnect.isPending || recover.isPending || stop.isPending || retryDelivery.isPending;
  const error = state.error ?? pair.error ?? configure.error ?? verify.error ?? disconnect.error ?? recover.error ?? stop.error ?? retryDelivery.error;
  const recovering = state.data?.recoveryNeeded || routine?.recoveryNeeded;
  const pending = exchange && ["prepared", "sending", "accepted"].includes(exchange.status) && Date.parse(exchange.expiresAt) > Date.now();
  return <section aria-label={t("components.grokBotConnection.grokBotConnection")} className="space-y-4 text-sm">
    <p className="text-muted-foreground">{t("components.grokBotConnection.runsInGrokBotTheBot")}</p>
    {state.isPending && <p role="status">{t("components.grokBotConnection.loadingConnection")}</p>}
    {error && <p role="alert" className="text-destructive">{error.message}</p>}
    {state.data && !state.data.enabled && <p className="text-muted-foreground">{t("components.grokBotConnection.enableGrokBotAssistantConnectionsMcp")}</p>}
    {binding?.connected ? <>
      <p>Agent access connected. {routine?.verified && !recovering ? t("components.grokBotConnection.routineRoundTripVerified") : t("components.grokBotConnection.assignmentsRequireAVerifiedRoutineRound")}</p>
      <dl className="space-y-2 text-muted-foreground"><div><dt>Bot</dt><dd>{routine?.botName ?? t("components.grokBotConnection.notConfigured")}</dd></div><div><dt>{t("components.grokBotConnection.lastVerifiedExchange")}</dt><dd>{routine?.verifiedAt ? new Date(routine.verifiedAt).toLocaleString() : t("components.grokBotConnection.notYetVerified")}</dd></div><div><dt>{t("components.grokBotConnection.lastAuthenticatedContact")}</dt><dd>{routine?.lastContactAt ? new Date(routine.lastContactAt).toLocaleString() : t("components.grokBotConnection.notYetObserved")}</dd></div></dl>
      {exchange && <p>Assignment delivered: {["accepted", "acknowledged"].includes(exchange.status) ? t("components.grokBotConnection.yes") : t("components.grokBotConnection.unconfirmed")}. Reply received: {exchange.acknowledgedAt ? t("components.grokBotConnection.yes") : "No"}.</p>}
      {exchange?.status === "rejected" && <div className="space-y-2"><p>{t("components.grokBotConnection.theRoutineRejectedThisDeliveryCheck")}</p><Button variant="outline" disabled={busy || recovering} onClick={() => retryDelivery.mutate(exchange.id)}>{t("components.grokBotConnection.retryRejectedDelivery")}</Button></div>}
      {!routine?.configured || replace ? <div className="space-y-3">
        <label className="block space-y-2"><span>{t("components.grokBotConnection.botNameInGrok")}</span><Input value={botName} onChange={e => setBotName(e.target.value)} maxLength={100} /></label>
        <AgentSetupPrompt prompt={buildGrokRoutinePrompt(binding.id, botName || "your Bot")} label="Copy routine instructions" title="Enable assignments" description="Ask the Bot for a Webhook URL navigation link if clicking its routine does nothing." />
        <label className="block space-y-2"><span>{t("components.grokBotConnection.webhookUrl")}</span><Input type="password" autoComplete="off" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} /></label>
        <label className="block space-y-2"><span>{t("components.grokBotConnection.webhookKey")}</span><Input type="password" autoComplete="off" value={webhookKey} onChange={e => setWebhookKey(e.target.value)} /></label>
        <Button disabled={busy || recovering || !botName.trim() || !webhookUrl || !webhookKey} onClick={() => configure.mutate()}>{t("components.grokBotConnection.saveRoutine")}</Button>
      </div> : <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !!pending || recovering || !!binding.assignment} onClick={() => verify.mutate()}>{t("components.grokBotConnection.verifyConnection")}</Button>
        <Button variant="outline" disabled={busy || recovering || !!binding.assignment} onClick={() => setReplace(true)}>{t("components.grokBotConnection.replaceRoutineCredentials")}</Button>
      </div>}
    </> : <>
      <Button disabled={busy || !state.data?.enabled || !state.data.canConfigureConnection} onClick={() => pair.mutate()}>{t("components.grokBotConnection.reconnectAgentAccess")}</Button>
      {pairing && state.data?.resourceUrl && <>
        <AgentSetupPrompt prompt={buildGrokAccessPrompt(state.data.resourceUrl, botName || "your Bot")} label="Copy connection instructions" title="Reconnect Grok Bot" description="Complete OAuth in the browser. Keep this code out of Bot chat." />
        <div className="space-y-2">
          <label htmlFor={pairingCodeId}>{t("components.grokBotConnection.oneUsePairingCode")}</label>
          <div className="flex items-center gap-2">
            <Input id={pairingCodeId} type="password" autoComplete="off" readOnly value={pairing.pairingCode} onFocus={e => e.target.select()} />
            <CopyText text={pairing.pairingCode} ariaLabel="Copy pairing code" className={buttonVariants({ variant: "outline", size: "sm" })}>{t("components.grokBotConnection.copyCode")}</CopyText>
          </div>
          <p className="text-xs text-muted-foreground">{t("components.grokBotConnection.copyThisCodeIntoPaperclipS")}</p>
        </div>
      </>}
    </>}
    {binding?.assignment && <div className="space-y-2"><p>{binding.assignment.status === "offered" ? t("components.grokBotConnection.awaitingAcknowledgement") : t("components.grokBotConnection.workingInAPaperclipWorkSession")}</p><Button variant="outline" disabled={busy} onClick={() => stop.mutate(binding.assignment!.runId)}>{t("components.grokBotConnection.stopPaperclipWork")}</Button><p className="text-xs text-muted-foreground">{t("components.grokBotConnection.revokesThisSessionSPaperclipAuthority")}</p></div>}
    {recovering && <div className="space-y-3 rounded-md border border-border p-3">
      <p className="font-medium">{t("components.grokBotConnection.recoveryNeeded")}</p><p className="text-muted-foreground">{t("components.grokBotConnection.paperclipCannotDetermineWhetherGrokIs")}</p>
      <label className="flex items-start gap-2"><input type="checkbox" checked={inspected} onChange={e => setInspected(e.target.checked)} /><span>{t("components.grokBotConnection.iInspectedGrokAndResolvedThe")}</span></label>
      <Button variant="outline" disabled={busy || !inspected || !!binding?.assignment} onClick={() => recover.mutate()}>{t("components.grokBotConnection.clearRecoveryHold")}</Button>
      <p className="text-xs text-muted-foreground">{t("components.grokBotConnection.thisRecordsYourInspectionItDoes")}</p>
    </div>}
    {binding?.connected && <Button variant="outline" disabled={busy} onClick={() => disconnect.mutate()}>{t("components.grokBotConnection.disconnectAgentAccess")}</Button>}
  </section>;
}
