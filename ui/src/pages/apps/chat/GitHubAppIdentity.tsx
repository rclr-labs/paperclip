import { ExternalLink, RefreshCw } from "lucide-react";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { AgentAvatarDownload } from "@/components/AgentAvatarDownload";
import { GitHubSettingsDisclosure } from "./GitHubSettingsDisclosure";
import { CopyText } from "@/components/CopyText";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";

export function gitHubBotMention(endpoint: Pick<ChatEndpoint, "botUsername">) {
  const slug = endpoint.botUsername?.replace(/^@/, "").replace(/\[bot\]$/, "");
  return slug ? `@${slug}` : null;
}

export function gitHubAppSettingsUrl(endpoint: ChatEndpoint) {
  const github = endpoint.setup?.github;
  const slug = gitHubBotMention(endpoint)?.slice(1);
  if (!slug) return "https://github.com/settings/apps";
  if (github?.appOwnerType === "organization" && github.appOwnerLogin)
    return `https://github.com/organizations/${encodeURIComponent(github.appOwnerLogin)}/settings/apps/${encodeURIComponent(slug)}`;
  if (github?.appOwnerType === "personal")
    return `https://github.com/settings/apps/${encodeURIComponent(slug)}`;
  // Legacy manual connections may not record ownership type. Never assume it.
  return "https://github.com/settings/apps";
}

export function GitHubBotMention({ endpoint }: { endpoint: ChatEndpoint }) {
  const { t } = useTranslation();
  const mention = gitHubBotMention(endpoint);
  return mention ? (
    <CopyText
      text={mention}
      ariaLabel="Copy GitHub mention"
      title={t("pages.apps.chat.gitHubAppIdentity.copyGithubMention")}
      className="break-all font-mono text-xs"
    >
      {mention}
    </CopyText>
  ) : null;
}

/** Optional provider-owned branding, shared by completion and management. */
export function GitHubAppBranding({
  endpoint,
  avatarUrl,
}: {
  endpoint: ChatEndpoint;
  avatarUrl?: string;
}) {
  const { t } = useTranslation();
  return (
    <GitHubSettingsDisclosure title={t("pages.apps.chat.gitHubAppIdentity.githubAppNameAndLogo")}>
      <div className="mt-4 space-y-4">
        <p className="text-sm text-muted-foreground">
          {t("pages.apps.chat.gitHubAppIdentity.changeTheNameOrUploadA")}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {avatarUrl && (
            <>
              <img
                src={avatarUrl}
                alt={`${endpoint.assignedAgentName}’s avatar for download`}
                className="size-12 shrink-0 object-contain"
              />
              <AgentAvatarDownload
                avatarUrl={avatarUrl}
                name={endpoint.botLabel ?? endpoint.assignedAgentName}
              />
            </>
          )}
          <Button variant="outline" asChild>
            <a
              href={gitHubAppSettingsUrl(endpoint)}
              target="_blank"
              rel="noreferrer"
              aria-label={t("pages.apps.chat.gitHubAppIdentity.editAppNameAndLogoOn")}
            >
              Edit on GitHub <ExternalLink className="size-4" />
            </a>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Renaming also changes its @mention.{" "}
          <Link
            className="underline underline-offset-4"
            to={`/apps/chat/connect?provider=github&resume=${endpoint.id}&reconnect=1`}
          >
            {t("pages.apps.chat.gitHubAppIdentity.reconnectAfterward")}
          </Link>{" "}
          to update it here.
        </p>
      </div>
    </GitHubSettingsDisclosure>
  );
}

/** Provider-owned branding actions live beside the App identity, not among review rules. */
export function GitHubAppIdentityActions({
  endpoint,
  avatarUrl,
}: {
  endpoint: ChatEndpoint;
  avatarUrl?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1">
      {avatarUrl && (
        <AgentAvatarDownload
          avatarUrl={avatarUrl}
          name={endpoint.botLabel ?? endpoint.assignedAgentName}
          iconOnly
        />
      )}
      <Button variant="ghost" size="sm" asChild>
        <a
          href={gitHubAppSettingsUrl(endpoint)}
          target="_blank"
          rel="noreferrer"
          aria-label={t("pages.apps.chat.gitHubAppIdentity.editAppNameAndLogoOn")}
          title={t("pages.apps.chat.gitHubAppIdentity.changeTheAppNameOrUpload")}
        >
          Edit App <ExternalLink className="size-3.5" />
        </a>
      </Button>
      <Button variant="ghost" size="icon" asChild>
        <Link
          to={`/apps/chat/connect?provider=github&resume=${endpoint.id}&reconnect=1`}
          aria-label={t("pages.apps.chat.gitHubAppIdentity.refreshGithubAppIdentity")}
          title={t("pages.apps.chat.gitHubAppIdentity.reconnectAfterRenamingTheAppTo")}
        >
          <RefreshCw className="size-3.5" />
        </Link>
      </Button>
    </div>
  );
}
