import { useCallback } from "react";
import axios from "axios";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { mutate } from "swr";
import {
  reportKey,
  type AutoFiledGroup,
} from "@/lib/fork/classification-suggestions";

/**
 * Records a person's verdict on a group of auto-filed images (fork I52).
 *
 * Keep leaves the images and counts as an accepted draft; remove deletes
 * them from the dataset and counts as a rejected one. Either way the group
 * leaves the spot-check list. Resolves to whether the call went through.
 */
export function useSpotCheck(modelName: string) {
  const { t } = useTranslation(["fork"]);

  return useCallback(
    async (group: AutoFiledGroup, keep: boolean): Promise<boolean> => {
      try {
        await axios.post(`classification/${modelName}/suggestions/spot-check`, {
          event_id: group.event_id ?? "",
          category: group.category,
          files: group.files,
          keep,
        });
      } catch {
        toast.error(t("classificationSuggestions.report.spotCheckFailed"), {
          position: "top-center",
        });
        return false;
      }
      toast.success(
        t(
          keep
            ? "classificationSuggestions.report.keptGroup"
            : "classificationSuggestions.report.removedGroup",
          { count: group.files.length, category: group.category },
        ),
        { position: "top-center" },
      );
      void mutate(reportKey(modelName));
      return true;
    },
    [modelName, t],
  );
}
