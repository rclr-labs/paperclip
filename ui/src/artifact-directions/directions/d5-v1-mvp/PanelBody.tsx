import type { LabArtifact } from "../../kit";
import { PanelRow } from "./PanelRow";
import { useTranslation } from "@/i18n";

/**
 * The side panel's Artifacts tab: the task's artifacts as a flat list of
 * rows, newest first, 12px apart.
 */
export function PanelBody({ artifacts }: { artifacts: LabArtifact[] }) {
  const { t } = useTranslation();
  if (artifacts.length === 0) {
    // The shipped empty state's copy.
    return <p className="px-1 py-6 text-sm text-muted-foreground">{t("artifactdirections.directions.d5v1mvp.panelBody.noArtifactsYetWorkProductsDocuments")}</p>;
  }
  const rows = [...artifacts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <ul data-surface="panel" className="flex flex-col gap-(--v1-row-gap)">
      {rows.map((artifact) => (
        <PanelRow key={artifact.id} artifact={artifact} />
      ))}
    </ul>
  );
}
