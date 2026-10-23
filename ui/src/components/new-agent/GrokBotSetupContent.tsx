import { useId } from "react";
import { Check, Circle, Loader2 } from "lucide-react";
import { AGENT_ROLES, type CreateGrokInvitation, type DotPairing, type GrokConnection } from "@paperclipai/shared";
import { AdapterMark } from "../AdapterMark";
import { AgentSetupPrompt } from "../AgentSetupPrompt";
import { Button, buttonVariants } from "../ui/button";
import { CopyText } from "../CopyText";
import { Input } from "../ui/input";
import { NativeSelect } from "../ui/select";
import { DialogDescription, DialogTitle } from "../ui/dialog";
import { buildGrokAccessPrompt, buildGrokRoutinePrompt } from "@/lib/grok-bot-setup-prompt";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";

export type GrokSetupStep = 0 | 1 | 2 | 3;
export interface GrokBotSetupContentProps {
  step: GrokSetupStep; companyName: string; details: CreateGrokInvitation;
  created: boolean; loading?: boolean; busy?: boolean; error?: string;
  managers: Array<{ id: string; name: string }>;
  connection?: GrokConnection; pairing: DotPairing | null; approvalHref?: string;
  webhookUrl: string; webhookKey: string; editingCredentials?: boolean;
  onEditCredentials?: () => void;
  onDetails: (details: CreateGrokInvitation) => void;
  onCredentials: (url: string, key: string) => void;
  onBack: () => void; onExit: () => void; onNext: () => void; onRetry: () => void;
}
const steps = ["Identify Bot", "Connect access", "Enable assignments", "Verify"];
export function GrokBotSetupContent(p: GrokBotSetupContentProps) {
  const { t } = useTranslation();
  const pairingCodeId = useId();
  const binding = p.connection?.binding;
  const routine = binding?.routine;
  const exchange = routine?.lastExchange;
  const delivered = exchange?.status === "accepted" || exchange?.status === "acknowledged";
  const replied = !!routine?.verified && exchange?.status === "acknowledged";
  const ready = replied && p.connection?.agentLifecycleState === "ready" && !!p.connection.canConfigureConnection && !routine?.recoveryNeeded;
  const pending = exchange && ["prepared", "sending", "accepted"].includes(exchange.status) && Date.parse(exchange.expiresAt) > Date.now();
  const nextDisabled = p.busy || p.loading || !!p.approvalHref
    || p.step === 0 && (!p.details.name.trim() || !p.details.botName.trim())
    || p.step === 1 && !binding?.connected
    || p.step === 2 && ((!routine?.configured || p.editingCredentials) && (!p.webhookUrl || !p.webhookKey))
    || p.step === 3 && !ready && (!!pending || !!routine?.recoveryNeeded || !!replied);
  return <>
    <div className="min-h-0 space-y-6 overflow-y-auto px-6 pb-6 pt-8 sm:px-8">
      <div className="space-y-3 pr-5">
        <AdapterMark type="grok_bot" className="size-10" />
        <DialogTitle className="text-xl font-semibold tracking-tight">{ready ? "Your Grok Bot is connected" : "Connect your Grok Bot"}</DialogTitle>
        <DialogDescription className="text-sm leading-relaxed">{ready ? `${p.details.botName} can receive assignments and work with ${p.companyName}.` : `Bring an existing Bot into ${p.companyName}. It continues to run in Grok Bot.`}</DialogDescription>
      </div>
      <ol aria-label="Grok Bot setup" className="grid grid-cols-4 gap-2 text-xs text-muted-foreground">
        {steps.map((label, index) => <li key={label} aria-current={p.step === index ? "step" : undefined} className={p.step === index ? "font-medium text-foreground" : ""}>{index + 1}. {label}</li>)}
      </ol>
      {p.error && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{p.error}</p><Button variant="outline" disabled={p.busy} onClick={p.onRetry}>{t("components.newagent.grokBotSetupContent.tryAgain")}</Button></div>}
      {p.loading ? <p role="status" className="text-sm text-muted-foreground">{t("components.newagent.grokBotSetupContent.restoringSavedSetup")}</p> : p.approvalHref ? <p className="text-sm text-muted-foreground">{t("components.newagent.grokBotSetupContent.anOrganizationAdminNeedsToApprove")}</p> : <>
        {p.step === 0 && <div className="space-y-4">
          <label className="block space-y-2 text-sm"><span>{t("components.newagent.grokBotSetupContent.paperclipName")}</span><Input value={p.details.name} disabled={p.created} onChange={e => p.onDetails({ ...p.details, name: e.target.value })} autoComplete="off" maxLength={100} /></label>
          <label className="block space-y-2 text-sm"><span>{t("components.newagent.grokBotSetupContent.botNameInGrok")}</span><Input value={p.details.botName} disabled={p.created} onChange={e => p.onDetails({ ...p.details, botName: e.target.value })} autoComplete="off" maxLength={100} /></label>
          <p className="text-xs text-muted-foreground">{t("components.newagent.grokBotSetupContent.useTheNameShownInThe")}</p>
          <label className="block space-y-2 text-sm"><span>{t("components.newagent.grokBotSetupContent.role")}</span><NativeSelect disabled={p.created} value={p.details.role ?? "general"} onChange={e => p.onDetails({ ...p.details, role: e.target.value as CreateGrokInvitation["role"] })}>{AGENT_ROLES.map(role => <option key={role} value={role}>{role.replaceAll("_", " ")}</option>)}</NativeSelect></label>
          <label className="block space-y-2 text-sm"><span>{t("components.newagent.grokBotSetupContent.manager")}</span><NativeSelect disabled={p.created} value={p.details.reportsTo ?? ""} onChange={e => p.onDetails({ ...p.details, reportsTo: e.target.value || null })}><option value="">{t("components.newagent.grokBotSetupContent.noManager")}</option>{p.managers.map(manager => <option key={manager.id} value={manager.id}>{manager.name}</option>)}</NativeSelect></label>
        </div>}
        {p.step === 1 && <div className="space-y-4 text-sm">
          <p>{t("components.newagent.grokBotSetupContent.copyTheConnectionInstructionsIntoYour")}</p>
          {p.connection?.resourceUrl && <AgentSetupPrompt prompt={buildGrokAccessPrompt(p.connection.resourceUrl, p.details.botName)} label="Copy connection instructions" title="Connect Paperclip access" description="Send these instructions to your Bot. The pairing code stays in your browser." />}
          {!binding?.connected && p.pairing && <div className="space-y-2">
            <label htmlFor={pairingCodeId}>{t("components.newagent.grokBotSetupContent.oneUsePairingCode")}</label>
            <div className="flex items-center gap-2">
              <Input id={pairingCodeId} value={p.pairing.pairingCode} readOnly type="password" autoComplete="off" />
              <CopyText text={p.pairing.pairingCode} ariaLabel="Copy pairing code" className={buttonVariants({ variant: "outline", size: "sm" })}>{t("components.newagent.grokBotSetupContent.copyCode")}</CopyText>
            </div>
            <p className="text-xs text-muted-foreground">Copy this code into Paperclip’s authorization page. Do not paste it into Bot chat. Expires {new Date(p.pairing.expiresAt).toLocaleTimeString()}.</p>
          </div>}
          <p role="status" aria-live="polite" className="text-muted-foreground">{binding?.connected ? "Agent access connected." : "Watching for authorization. This connection works as the named agent."}</p>
          <p className="text-xs text-muted-foreground">{t("components.newagent.grokBotSetupContent.grokPluginsAreAccountWideLinking")}</p>
        </div>}
        {p.step === 2 && <div className="space-y-4 text-sm">
          <p>{t("components.newagent.grokBotSetupContent.askYourBotToCreateA")}</p>
          {binding && <AgentSetupPrompt prompt={buildGrokRoutinePrompt(binding.id, p.details.botName)} label="Copy routine instructions" title="Enable assignments" description="Send this to the connected Bot. The routine wakes it when Paperclip work changes." />}
          <p className="text-xs text-muted-foreground">{t("components.newagent.grokBotSetupContent.ifClickingTheRoutineDoesNothing")}</p>
          {routine?.configured && !p.editingCredentials && !p.webhookUrl && !p.webhookKey ? <div className="space-y-2"><p role="status" className="text-muted-foreground">{t("components.newagent.grokBotSetupContent.routineCredentialsAreStoredContinueTo")}</p>{p.onEditCredentials && <Button variant="outline" onClick={p.onEditCredentials} disabled={p.busy}>{t("components.newagent.grokBotSetupContent.replaceRoutineCredentials")}</Button>}</div> : <>
            <label className="block space-y-2"><span>{t("components.newagent.grokBotSetupContent.webhookUrl")}</span><Input value={p.webhookUrl} onChange={e => p.onCredentials(e.target.value, p.webhookKey)} type="password" autoComplete="off" spellCheck={false} /></label>
            <label className="block space-y-2"><span>{t("components.newagent.grokBotSetupContent.webhookKey")}</span><Input value={p.webhookKey} onChange={e => p.onCredentials(p.webhookUrl, e.target.value)} type="password" autoComplete="off" spellCheck={false} /></label>
          </>}
          <p className="text-xs text-muted-foreground">{t("components.newagent.grokBotSetupContent.copyTheseFieldsDirectlyFromGrok")}</p>
        </div>}
        {p.step === 3 && <section aria-label={t("components.newagent.grokBotSetupContent.grokConnectionChecks")} className="space-y-4 text-sm">
          {[{ label: "Assignment delivered", done: delivered }, { label: "Reply received", done: replied }].map(check => <p key={check.label} className="flex items-center gap-3">{check.done ? <Check className="size-4" /> : pending ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <Circle className="size-4 text-muted-foreground" />}{check.label}<span className="text-muted-foreground">{check.done ? "Complete" : "Waiting"}</span></p>)}
          <p role="status" aria-live="polite" className="text-muted-foreground">{routine?.recoveryNeeded ? "Recovery needed. Inspect Grok’s activity in this agent’s configuration before another delivery." : ready ? "Both directions verified. Your Bot is ready for tasks." : replied ? "Both directions verified. Paperclip is finishing agent setup." : exchange?.status === "rejected" ? "The routine rejected delivery. Check its URL and key, then try again." : delivered ? "The routine accepted delivery. Waiting for an authenticated reply to Paperclip." : "Send a harmless challenge. This creates no task."}</p>
          <p className="text-xs text-muted-foreground">{t("components.newagent.grokBotSetupContent.grokRunsExternallyUsageAndSpending")}</p>
        </section>}
      </>}
    </div>
    <div className="flex items-center justify-between gap-3 border-t px-6 py-4 sm:px-8">
      <div className="flex items-center gap-2"><Button variant="ghost" onClick={p.onBack} disabled={p.busy}>{t("components.newagent.grokBotSetupContent.back")}</Button><Button variant="ghost" onClick={p.onExit} disabled={p.busy}>{t("components.newagent.grokBotSetupContent.saveExit")}</Button></div>
      {p.approvalHref ? <Button asChild><Link to={p.approvalHref} onClick={p.onExit}>{t("components.newagent.grokBotSetupContent.reviewApproval")}</Link></Button> : <Button onClick={p.onNext} disabled={nextDisabled}>{p.busy ? "Saving…" : ready ? "Done" : p.step === 3 ? pending ? "Waiting for reply…" : replied ? "Finishing setup…" : "Verify connection" : "Continue"}</Button>}
    </div>
  </>;
}
