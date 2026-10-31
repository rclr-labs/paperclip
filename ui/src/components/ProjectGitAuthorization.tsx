import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { useTranslation } from "@/i18n";

export function ProjectGitAuthorization({ project }: { project: Project }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const key = ["project-git-authorization", project.companyId, project.id];
  const authorization = useQuery({
    queryKey: key,
    queryFn: () => projectsApi.gitAuthorization(project.id),
  });
  const [selected, setSelected] = useState<string>("");
  const save = useMutation({
    mutationFn: (grantId: string | null) => projectsApi.setGitAuthorization(project.id, grantId),
    onSuccess: (data) => {
      client.setQueryData(key, data);
      setSelected("");
    },
  });
  const data = authorization.data;
  return (
    <section aria-label={t("components.projectGitAuthorization.backgroundGithubAuthorization")} className="flex flex-col gap-3 py-4">
      <h3 className="text-sm font-medium">{t("components.projectGitAuthorization.backgroundGithubAuthorization")}</h3>
      <p className="text-sm text-muted-foreground">
        {t("components.projectGitAuthorization.allowThisProjectSWorkspaceProvider")}
      </p>
      {data?.grantId && (
        <p role="status" className="text-sm">
          Authorized:{" "}
          {data.options.find((option) => option.grantId === data.grantId)?.login ??
            t("components.projectGitAuthorization.selectedGrantUnavailableOrOwnedBy")}
        </p>
      )}
      {data && (
        <div className="flex flex-wrap gap-2">
          <Select value={selected} onValueChange={setSelected} disabled={save.isPending}>
            <SelectTrigger aria-label={t("components.projectGitAuthorization.yourGithubAuthorization")}>
              <SelectValue placeholder={t("components.projectGitAuthorization.selectYourGithubAccount")} />
            </SelectTrigger>
            <SelectContent>
              {data.options.map((option) => (
                <SelectItem key={option.grantId} value={option.grantId}>
                  {option.login} · {option.connectionName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button disabled={!selected || save.isPending} onClick={() => save.mutate(selected)}>
            {t("components.projectGitAuthorization.authorizeProject")}
          </Button>
          {data.grantId && (
            <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate(null)}>
              {t("components.projectGitAuthorization.revokeAuthorization")}
            </Button>
          )}
        </div>
      )}
      {data && !data.options.length && (
        <p className="text-sm text-muted-foreground">
          {t("components.projectGitAuthorization.connectYourGithubAccountAndInstall")}
        </p>
      )}
      {(authorization.error || save.error) && (
        <p role="alert" className="text-sm text-destructive">
          {(authorization.error || save.error)?.message}
        </p>
      )}
    </section>
  );
}
