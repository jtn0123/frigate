import { useTranslation } from "react-i18next";
import { isForkEnabled } from "@/fork/flags";
import {
  ID_LIVE,
  ID_REVIEW,
  ID_EXPLORE,
  ID_EXPORT,
  ID_FACE_LIBRARY,
  ID_CLASSIFICATION,
  ID_CHAT,
} from "@/hooks/use-navigation";

/** Short destination descriptions for the desktop rail's icon-only links. */
export default function RailNavHint({ id }: Readonly<{ id: number }>) {
  const { t } = useTranslation(["fork"]);
  const hints: Record<number, string> = {
    [ID_LIVE]: t("railHints.live"),
    [ID_REVIEW]: t("railHints.review"),
    [ID_EXPLORE]: t("railHints.explore"),
    [ID_EXPORT]: t("railHints.export"),
    [ID_FACE_LIBRARY]: t("railHints.faces"),
    [ID_CLASSIFICATION]: t("railHints.classification"),
    [ID_CHAT]: t("railHints.chat"),
  };
  const hint = hints[id];
  if (!isForkEnabled("themeControls") || !hint) return null;
  return <p className="mt-1 max-w-56 text-xs text-muted-foreground">{hint}</p>;
}
