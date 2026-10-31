import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";

export function LegacyBoardSendNotice({ onDiscard }: { onDiscard: () => void }) {
  const { t } = useTranslation();
  return <AlertDialog>
    <AlertDialogTrigger asChild>
      <Button size="sm" variant="outline">{t("components.chat.legacyBoardSendNotice.discardSavedDeliveryRecord2")}</Button>
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{t("components.chat.legacyBoardSendNotice.discardSavedDeliveryRecord")}</AlertDialogTitle>
        <AlertDialogDescription>
          {t("components.chat.legacyBoardSendNotice.firstCheckActivityDiscardingThisBrowser")}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{t("components.chat.legacyBoardSendNotice.keepRecord")}</AlertDialogCancel>
        <AlertDialogAction onClick={onDiscard}>{t("components.chat.legacyBoardSendNotice.discardRecord")}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
