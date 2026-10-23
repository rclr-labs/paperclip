import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { museDetectorCleanupAttestationSchema } from "@paperclipai/shared";
import type { MuseConnection, MusePairing, MuseAttestStopInput, MuseDetectorCleanupAttestationInput } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { useMuseConnection, useMuseConnectionState } from "@/hooks/useMuseConnection";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";
import { AgentSetupPrompt } from "./AgentSetupPrompt";
import { MuseConnectionChecks } from "./new-agent/ExternalAgentInviteContent";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { useTranslation } from "@/i18n";

export interface MuseConnectionDetailsProps {
  connection: MuseConnection;
  pairing?: MusePairing | null;
  busy?: boolean;
  error?: string;
  offline?: boolean;
  onTest: () => void;
  onRepair: () => void;
  onPause: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
  onAttest: (input: MuseAttestStopInput) => void;
  onAttestDetectorCleanup?: (input: MuseDetectorCleanupAttestationInput) => void;
}

/** The settings view uses the same connection evidence as the invitation. */
export function MuseConnectionDetails({ connection, pairing, busy, error, offline = false, onTest, onRepair, onPause, onDisconnect, onRefresh, onAttest, onAttestDetectorCleanup }: MuseConnectionDetailsProps) {
  const { t } = useTranslation();
  const b = connection.binding;
  const [attestation, setAttestation] = useState<MuseAttestStopInput | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [detectorSnapshot, setDetectorSnapshot] = useState<Omit<MuseDetectorCleanupAttestationInput, "observation" | "detectorRemoved"> | null>(null);
  const [detectorHookId, setDetectorHookId] = useState("");
  const [observationDigest, setObservationDigest] = useState("");
  const [detectorObservedAt, setDetectorObservedAt] = useState("");
  const detectorObservedAtValid = museDetectorCleanupAttestationSchema.shape.observation.shape.observedAt.safeParse(detectorObservedAt).success;
  const [detectorConfirmed, setDetectorConfirmed] = useState(false);
  const detectorIdentity = JSON.stringify([b?.id, b?.generation, b?.revision, b?.qualification?.id, b?.cleanup.hookScript, b?.cleanup.attestationEligible, offline]);
  useEffect(() => { setDetectorSnapshot(null); setObservationDigest(""); setDetectorObservedAt(""); setDetectorHookId(""); setDetectorConfirmed(false); }, [detectorIdentity]);
  const boundaryIdentity = JSON.stringify(b?.stop.boundary);
  const stopBindingRevision = b?.stop.bindingRevision;
  useEffect(() => { setAttestation(null); setConfirmed(false); }, [boundaryIdentity, stopBindingRevision]);
  const live = !!b && b.status !== "revoked";
  const state = useMuseConnectionState(connection, { offline });
  const testing = state.testing;
  const configure = !offline && connection.enabled && connection.canConfigureConnection && !!connection.publicOrigin;
  const timestamp = (value: string | null) => value ? formatDateTime(value, { includeSeconds: true }) : "Not observed";
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">{t("components.museRunnerConnection.museUsesItsOwnToolsAnd")}</p>
    {!connection.enabled && <p className="text-sm text-muted-foreground">{t("components.museRunnerConnection.museIsDisabledInExperimentalSettings")}</p>}
    {!connection.publicOrigin && <p className="text-sm text-muted-foreground">{t("components.museRunnerConnection.anAuthenticatedInstanceWithAPublic")}</p>}
    {b && <>
      <MuseConnectionChecks state={state} />
      <dl className="space-y-2 text-xs">
        {[
          ["Last persisted public receiver contact", timestamp(b.lastReceiverContactAt)],
          ["Authenticated worker activity", timestamp(b.lastWorkerActivityAt)],
          ["Last verified reply", timestamp(b.lastVerifiedReplyAt)],
          ["Credential status", b.credentialState],
          ["Refresh credential expires", timestamp(b.refreshExpiresAt)],
          ["Client version", b.clientVersion ?? "Not reported"],
          ["Live assignments", String(b.liveAssignments)],
          ["Uncertain native operations", String(b.uncertainOperations)],
          ["Pending answers", String(b.pendingInputs)],
          ["Usage and cost", "Unavailable"],
        ].map(([label, value]) => <div key={label} className="flex flex-wrap items-baseline justify-between gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="font-mono">{value}</dd></div>)}
      </dl>
      <p className="text-xs text-muted-foreground">Receiver contact is persisted in batches and may lag by up to {Math.ceil(b.contactPersistenceLagMs / 1000)} seconds. Public receiver checks are unverified. Only an authenticated reply confirms Muse can work.</p>
      {b.status === "revoked" && <p role="status" className="text-sm text-muted-foreground">{t("components.museRunnerConnection.disconnectedPaperclipCredentialsAndExecutionAuthority")}</p>}
      {(b.cleanup.pending || b.status === "revoked") && <div className="space-y-2 text-sm text-muted-foreground">
        {"detectorRemovalRequested" in b.cleanup && b.cleanup.detectorRemovalRequested === true && !b.cleanup.detectorRemoved && <p>{t("components.museRunnerConnection.detectorRemovalRequestedCompletionIsNot")}</p>}
        <p>Detector removal: {b.cleanup.detectorEvidence?.source === "operator_runtime_attestation" ? "operator-attested" : b.cleanup.detectorRemoved ? "acknowledged" : t("components.museRunnerConnection.notConfirmed")}. Worker quiescence: {b.cleanup.workerQuiescenceReported ? "reported" : t("components.museRunnerConnection.notConfirmed")}.</p>
        {b.cleanup.authenticatedAfterRevocation === false && <p>{t("components.museRunnerConnection.afterDisconnectTheReceiverDisablesItself")}</p>}
        {b.cleanup.expiresAt && <p className="text-xs">Cleanup capability expires {formatDateTime(b.cleanup.expiresAt)}.</p>}
        {b.cleanup.detectorEvidence && <p>Recorded {timestamp(b.cleanup.detectorEvidence.recordedAt)}: {b.cleanup.detectorEvidence.source === "operator_runtime_attestation" ? t("components.museRunnerConnection.operatorAttestationFromASupportedRuntime") : t("components.museRunnerConnection.authenticatedWorkerReport")}. This is not independent provider confirmation.</p>}
        {b.cleanup.attestationEligible && onAttestDetectorCleanup && !detectorSnapshot && <Button type="button" variant="outline" disabled={busy || offline} onClick={() => {
          if (!b.cleanup.hookScript) return;
          setDetectorSnapshot({ bindingId: b.id, generation: b.generation, expectedRevision: b.revision, qualificationId: b.qualification?.id ?? null, hookScript: b.cleanup.hookScript });
        }}>{t("components.museRunnerConnection.recordDetectorRemovalObservation")}</Button>}
        <p>{t("components.museRunnerConnection.detectorRemovalWorkerStoppingAndSandbox")}</p>
      </div>}
      {b.stop.status !== "none" && <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">{b.stop.status === "operator_attested" ? t("components.museRunnerConnection.youAttestedThatThisAssignmentS")
          : b.stop.status === "worker_reported" ? t("components.museRunnerConnection.museReportedThatThisAssignmentS")
          : t("components.museRunnerConnection.paperclipFencedThisAssignmentSAuthority")}</p>
        {b.stop.nativeEffectsUnknown && <p role="status" className="text-muted-foreground">{t("components.museRunnerConnection.nativeEffectOutcomesRemainUnknownAnd")}</p>}
        {b.stop.boundary && stopBindingRevision == null && b.stop.status !== "operator_attested" && <p role="status" className="text-muted-foreground">{t("components.museRunnerConnection.stopBindingRevisionIsUnavailableRefresh")}</p>}
        {b.stop.boundary && b.stop.status !== "operator_attested" && !attestation && <Button type="button" variant="outline" disabled={busy || stopBindingRevision == null} onClick={() => {
          if (!b.stop.boundary || stopBindingRevision == null) return;
          setAttestation({ boundary: { ...b.stop.boundary }, expectedRevision: stopBindingRevision, workerStopped: true }); setConfirmed(false);
        }}>{t("components.museRunnerConnection.attestThisWorkerStopped")}</Button>}
      </div>}
    </>}
    {detectorSnapshot && <section aria-label={t("components.museRunnerConnection.recordExactMuseDetectorRemoval")} className="space-y-3 rounded-md border border-border p-3">
      <p className="text-sm font-medium">{t("components.museRunnerConnection.recordAnObservationOfThisExact")}</p>
      <p className="break-all font-mono text-xs">{detectorSnapshot.hookScript}</p>
      <p className="text-sm text-muted-foreground">Use Muse’s supported <code>{"hooks.list({ include_disabled: true })"}</code> after revocation to verify this exact registered script is absent. Disabled checks, silence, or a removal request are insufficient. The retained hook ID and observation are your report. Paperclip does not verify installation, query Muse, or remove the hook.</p>
      <label className="block space-y-2 text-sm">{t("components.museRunnerConnection.registeredHookId")}<Input aria-label={t("components.museRunnerConnection.registeredMuseHookId")} value={detectorHookId} onChange={event => { setDetectorHookId(event.target.value); setDetectorConfirmed(false); }} autoComplete="off" /></label>
      <label className="block space-y-2 text-sm">{t("components.museRunnerConnection.observationSha256")}<Input aria-label={t("components.museRunnerConnection.detectorRemovalObservationSha256")} value={observationDigest} onChange={event => { setObservationDigest(event.target.value); setDetectorConfirmed(false); }} autoComplete="off" /></label>
      <p className="text-xs text-muted-foreground">{t("components.museRunnerConnection.useTheDigestOfTheSecret")}</p>
      <label className="block space-y-2 text-sm">{t("components.museRunnerConnection.observedAtUtc")}<Input aria-label={t("components.museRunnerConnection.detectorRemovalObservedAtUtc")} value={detectorObservedAt} onChange={event => { setDetectorObservedAt(event.target.value); setDetectorConfirmed(false); }} placeholder="YYYY-MM-DDTHH:mm:ss.sssZ" autoComplete="off" /></label>
      <p className="text-xs text-muted-foreground">{t("components.museRunnerConnection.enterTheActualRuntimeListingTime")}</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={detectorConfirmed} onChange={event => setDetectorConfirmed(event.target.checked)} className="mt-1 accent-primary" /><span>{t("components.museRunnerConnection.iObservedThisExactHookAbsent")}</span></label>
      <div className="flex items-center justify-between gap-3"><Button type="button" variant="ghost" onClick={() => setDetectorSnapshot(null)}>{t("components.museRunnerConnection.cancel")}</Button><Button type="button" disabled={!detectorConfirmed || !detectorObservedAtValid || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(detectorHookId) || !/^[a-f0-9]{64}$/.test(observationDigest) || busy || offline} onClick={() => onAttestDetectorCleanup?.({ ...detectorSnapshot, detectorRemoved: true, observation: { method: "hooks.list", includeDisabled: true, hookId: detectorHookId, outcome: "exact_hook_absent", observedAt: detectorObservedAt, sha256: observationDigest } })}>{t("components.museRunnerConnection.confirmDetectorObservation")}</Button></div>
    </section>}
    {attestation && <section aria-label={t("components.museRunnerConnection.attestThisMuseWorkerStopped")} className="space-y-3 rounded-md border border-border p-3">
      <p className="text-sm font-medium">{t("components.museRunnerConnection.confirmTheWorkerForThisExact")}</p>
      <dl className="space-y-2 text-xs">
        {Object.entries(attestation.boundary).map(([key, value]) => <div key={key} className="flex flex-wrap items-baseline justify-between gap-2"><dt className="text-muted-foreground">{key}</dt><dd className="break-all font-mono">{value === null ? "None" : String(value)}</dd></div>)}
      </dl>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 accent-primary" /><span>{t("components.museRunnerConnection.iHaveStoppedThisMuseWorker")}</span></label>
      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={() => setAttestation(null)}>{t("components.museRunnerConnection.cancel")}</Button>
        <Button type="button" disabled={!confirmed || busy} onClick={() => onAttest(attestation)}>{t("components.museRunnerConnection.confirmWorkerStopped")}</Button>
      </div>
    </section>}
    {pairing && !b?.paired && <div className="space-y-2">
      <AgentSetupPrompt key={pairing.bindingId + pairing.revision} prompt={pairing.setupInstruction} label="Copy setup prompt" title="Connect your Muse" agent={{ name: "Muse", icon: <Bot className="size-5" /> }} description="Paste into your current Muse conversation. Complete Connect Paperclip if Muse asks, then approve the Paperclip hostname." />
      <p className="text-xs text-muted-foreground">One-use setup expires {formatDateTime(pairing.expiresAt)}. Muse keeps the connection credential in its secure vault. Hostname permission applies to future requests to this Paperclip hostname.</p>
    </div>}
    <div className="flex flex-wrap items-center gap-2">
      {live && <Button type="button" variant="outline" disabled={!configure || b.credentialState !== "active" || !b.paired || busy || testing} onClick={onTest}>{testing ? t("components.museRunnerConnection.testingBackgroundReply") : t("components.museRunnerConnection.testBackgroundReply")}</Button>}
      <Button type="button" variant="outline" disabled={!configure || busy} onClick={onRepair}>{b?.credentialState === "expired" ? t("components.museRunnerConnection.reconnectMuse") : live ? t("components.museRunnerConnection.repairConnection") : t("components.museRunnerConnection.connectMuse")}</Button>
      {connection.agentStatus !== "paused" && connection.agentStatus !== "terminated" && <Button type="button" variant="outline" disabled={busy} onClick={onPause}>{t("components.museRunnerConnection.pauseAgent")}</Button>}
      {live && <Button type="button" variant="outline" disabled={busy} onClick={onDisconnect}>{t("components.museRunnerConnection.disconnect")}</Button>}
      <Button type="button" variant="ghost" disabled={busy} onClick={onRefresh}>{t("components.museRunnerConnection.refresh")}</Button>
      <Button type="button" asChild variant="ghost"><a href="https://muse.ai" target="_blank" rel="noopener noreferrer">Open Muse</a></Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}

export function MuseRunnerConnection({ companyId, agentId }: { companyId?: string; agentId?: string }) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const muse = useMuseConnection(companyId, agentId);
  const pause = useMutation({ mutationFn: () => agentsApi.pause(agentId!, companyId), onSuccess: () => {
    void muse.refresh(); void cache.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId!) });
    if (companyId) void cache.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) });
  } });
  if (!agentId) return <p className="text-sm text-muted-foreground">{t("components.museRunnerConnection.saveTheAgentThenConnectYour")}</p>;
  const error = muse.state.error ?? muse.pair.error ?? muse.verify.error ?? muse.revoke.error ?? muse.attest.error ?? muse.attestDetector.error ?? pause.error;
  if (muse.identity.failed) return <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{t("components.museRunnerConnection.unableToConfirmYourAccountRefresh")}</p><Button type="button" variant="outline" onClick={() => { void cache.invalidateQueries({ queryKey: queryKeys.auth.session }); }}>{t("components.museRunnerConnection.refresh")}</Button></div>;
  if (!muse.state.data) return <div className="space-y-3"><p role="status" className="text-sm text-muted-foreground">{muse.state.error ? t("components.museRunnerConnection.unableToLoadTheMuseConnection") : t("components.museRunnerConnection.loadingMuseConnection")}</p>{error && <p role="alert" className="text-sm text-destructive">{error.message}</p>}<Button type="button" variant="outline" onClick={() => { void muse.state.refetch(); }}>{t("components.museRunnerConnection.refresh")}</Button></div>;
  return <MuseConnectionDetails key={muse.identity.userId} connection={muse.state.data} pairing={muse.pairing} offline={muse.state.isError}
    busy={muse.pair.isPending || muse.verify.isPending || muse.revoke.isPending || muse.attest.isPending || muse.attestDetector.isPending || pause.isPending}
    error={error?.message} onTest={() => { if (muse.binding) muse.verify.mutate(muse.binding); }} onRepair={muse.repair}
    onPause={() => pause.mutate()} onDisconnect={() => { if (muse.binding) muse.revoke.mutate(muse.binding); }}
    onRefresh={() => { void muse.state.refetch(); }} onAttest={input => muse.attest.mutate(input)} onAttestDetectorCleanup={input => muse.attestDetector.mutate(input)} />;
}
