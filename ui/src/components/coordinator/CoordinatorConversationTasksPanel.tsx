import { useMemo, useState } from "react";
import { useCoordinatorChatTaskHandoffs } from "./CoordinatorChatTaskHandoffs";
import { CoordinatorCreatedTaskLink } from "./CoordinatorTaskCommitment";
import { ToolbarSearch } from "@/components/ToolbarSearch";
import { NativeSelect } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";

/** The task list is source-conversation scoped, independent of reassignment. */
export function CoordinatorConversationTasksPanel({ conversationIssueId }: { conversationIssueId: string }) {
  const { t } = useTranslation();
  const tasks = useCoordinatorChatTaskHandoffs(conversationIssueId);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("newest");
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return tasks.handoffs.filter(task => (!status || task.status === status) && (!needle || `${task.identifier ?? ""} ${task.title}`.toLocaleLowerCase().includes(needle)))
      .sort((a, b) => sort === "title" ? a.title.localeCompare(b.title) : (sort === "oldest" ? 1 : -1) * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()));
  }, [tasks.handoffs, query, status, sort]);
  return <section className="space-y-4" aria-label={t("components.coordinator.coordinatorConversationTasksPanel.tasksFromThisConversation")}>
    <div className="space-y-1"><h2 className="text-lg font-medium">{t("components.coordinator.coordinatorConversationTasksPanel.tasks")}</h2><p className="text-sm text-muted-foreground">{t("components.coordinator.coordinatorConversationTasksPanel.createdFromThisConversation")}</p></div>
    <ToolbarSearch query={query} onQueryChange={setQuery} label="Search conversation tasks" placeholder={t("components.coordinator.coordinatorConversationTasksPanel.searchTasksOrIds")} />
    <div className="flex flex-wrap gap-2">
      <NativeSelect value={status} onChange={event => setStatus(event.target.value)} aria-label={t("components.coordinator.coordinatorConversationTasksPanel.filterConversationTasksByStatus")} className="w-auto"><option value="">{t("components.coordinator.coordinatorConversationTasksPanel.allStatuses")}</option><option value="todo">{t("components.coordinator.coordinatorConversationTasksPanel.readyToStart")}</option><option value="in_progress">{t("components.coordinator.coordinatorConversationTasksPanel.inProgress")}</option><option value="in_review">{t("components.coordinator.coordinatorConversationTasksPanel.needsReview")}</option><option value="blocked">{t("components.coordinator.coordinatorConversationTasksPanel.blocked")}</option><option value="done">{t("components.coordinator.coordinatorConversationTasksPanel.done")}</option><option value="cancelled">{t("components.coordinator.coordinatorConversationTasksPanel.cancelled")}</option></NativeSelect>
      <NativeSelect value={sort} onChange={event => setSort(event.target.value)} aria-label={t("components.coordinator.coordinatorConversationTasksPanel.sortConversationTasks")} className="w-auto"><option value="newest">{t("components.coordinator.coordinatorConversationTasksPanel.newestFirst")}</option><option value="oldest">{t("components.coordinator.coordinatorConversationTasksPanel.oldestFirst")}</option><option value="title">{t("components.coordinator.coordinatorConversationTasksPanel.title")}</option></NativeSelect>
    </div>
    {tasks.isPending && <p role="status" className="text-sm text-muted-foreground">{t("components.coordinator.coordinatorConversationTasksPanel.loadingTasks")}</p>}
    {tasks.isError && <div role="alert" className="space-y-2"><p className="text-sm">{t("components.coordinator.coordinatorConversationTasksPanel.tasksCouldnTLoad")}</p><Button variant="outline" onClick={() => void tasks.refetch()}>{t("components.coordinator.coordinatorConversationTasksPanel.retry")}</Button></div>}
    <div className="space-y-3">{visible.map(task => <div key={task.id} className="overflow-hidden rounded-xl border border-border bg-card"><CoordinatorCreatedTaskLink task={task} /></div>)}</div>
    {!tasks.isPending && !tasks.isError && !visible.length && <p className="py-4 text-sm text-muted-foreground">{query || status ? t("components.coordinator.coordinatorConversationTasksPanel.noLoadedTasksMatchTheseFilters") : t("components.coordinator.coordinatorConversationTasksPanel.tasksCreatedFromThisConversationWill")}</p>}
    {tasks.hasNextPage && <Button variant="outline" disabled={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>{tasks.isFetchingNextPage ? t("components.coordinator.coordinatorConversationTasksPanel.loading") : t("components.coordinator.coordinatorConversationTasksPanel.loadMoreTasks")}</Button>}
  </section>;
}
