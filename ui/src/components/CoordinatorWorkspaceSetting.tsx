import { useQuery } from "@tanstack/react-query";
import { experimentalSettingKey } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useCompany } from "@/context/CompanyContext";
import { useCoordinatorWorkspaceEnabled } from "@/hooks/useCoordinatorWorkspaceEnabled";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useTranslation } from "@/i18n";

export function CoordinatorWorkspaceSetting() {
  const { t } = useTranslation();
  const { selectedCompany } = useCompany();
  const workspace = useCoordinatorWorkspaceEnabled();
  const { hidden, loaded: visibilityLoaded } = useHiddenSettings();
  const experimental = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const chatDisabled = experimental.isSuccess && experimental.data.enableAgentChat !== true;
  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: chatDisabled && !!workspace.userId,
    retry: false,
    staleTime: 30_000,
  });
  const chatManaged = experimental.data?.managedKeys?.enableAgentChat?.managed === true;
  const chatHidden = hidden.has(experimentalSettingKey("enableAgentChat"));
  const canEnableChat = visibilityLoaded && !chatHidden && !chatManaged && boardAccess.data?.userId === workspace.userId && (
    boardAccess.data?.source === "local_implicit" || boardAccess.data?.isInstanceAdmin === true
  );
  const error = workspace.error instanceof Error ? workspace.error.message : null;
  return (
    <Card className="block bg-transparent p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <h3 id="coordinator-workspace-title" className="text-sm font-medium">{t("components.coordinatorWorkspaceSetting.coordinatorWorkspace")}</h3>
          <p id="coordinator-workspace-description" className="text-sm text-muted-foreground">
            {t("components.coordinatorWorkspaceSetting.tryTheNewChatTasksAnd")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("components.coordinatorWorkspaceSetting.offByDefaultTurnItOff")}
          </p>
          {workspace.userId === "local-board" && (
            <p className="text-xs text-muted-foreground">{t("components.coordinatorWorkspaceSetting.thisLocalInstanceUsesTheShared")}</p>
          )}
          {chatDisabled && (
            <p className="text-sm text-muted-foreground">
              Agent Chat is off for this instance. Your workspace preference does not enable it.{" "}
              {canEnableChat ? (
                <a href="#experimental-enableAgentChat" className="underline underline-offset-4">{t("components.coordinatorWorkspaceSetting.enableAgentChatBelow")}</a>
              ) : chatManaged || chatHidden ? (
                t("components.coordinatorWorkspaceSetting.chatAvailabilityIsManagedByYour")
              ) : (
                t("components.coordinatorWorkspaceSetting.askAnAdministratorToEnableAgent")
              )}
            </p>
          )}
        </div>
        <ToggleSwitch
          checked={workspace.enabled}
          disabled={!workspace.loaded || workspace.isSaving || !workspace.userId || !selectedCompany || !!workspace.error}
          aria-label={t("components.coordinatorWorkspaceSetting.enableCoordinatorWorkspace")}
          aria-describedby="coordinator-workspace-description"
          onCheckedChange={(enabled) => {
            if (!selectedCompany) return;
            // The hook exposes the error for the account that attempted the save.
            void workspace.setEnabled(selectedCompany.id, enabled).catch(() => {});
          }}
        />
      </div>
      {workspace.isSaving && <p role="status" className="mt-3 text-sm text-muted-foreground">{t("components.coordinatorWorkspaceSetting.savingYourWorkspace")}</p>}
      {!workspace.loaded && <p role="status" className="mt-3 text-sm text-muted-foreground">{t("components.coordinatorWorkspaceSetting.loadingYourPreference")}</p>}
      {error && (
        <div role="alert" className="mt-3 flex items-center gap-2 text-sm text-destructive">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={() => { void workspace.retry(); }}>{t("components.coordinatorWorkspaceSetting.retry")}</Button>
        </div>
      )}
    </Card>
  );
}
