import { useState } from "react";
import {
  Drawer,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "../ui/drawer";
import { Button } from "../ui/button";
import { FaFlag } from "react-icons/fa";
import { TimelineType } from "@/types/timeline";
import { isMobile } from "react-device-detect";
import { useTranslation } from "react-i18next";

type MobileTimelineDrawerProps = {
  selected: TimelineType;
  onSelect: (timeline: TimelineType) => void;
};
export default function MobileTimelineDrawer({
  selected,
  onSelect,
}: MobileTimelineDrawerProps) {
  const { t } = useTranslation(["views/events"]);
  const [drawer, setDrawer] = useState(false);

  if (!isMobile) {
    return;
  }

  return (
    <Drawer open={drawer} onOpenChange={setDrawer}>
      <DrawerTrigger asChild>
        <Button
          className="rounded-lg smart-capitalize"
          aria-label={t("timeline.aria")}
          size="sm"
        >
          <FaFlag className="text-secondary-foreground" />
        </Button>
      </DrawerTrigger>
      <DrawerContent className="mx-1 flex max-h-[75dvh] flex-col items-center gap-2 overflow-hidden rounded-t-2xl px-4 pb-4">
        <DrawerTitle className="sr-only">{t("timeline.aria")}</DrawerTitle>
        <button
          type="button"
          className={`mx-4 w-full py-2 text-center smart-capitalize ${selected == "timeline" ? "rounded-lg bg-secondary" : ""}`}
          aria-pressed={selected == "timeline"}
          onClick={() => {
            onSelect("timeline");
            setDrawer(false);
          }}
        >
          {t("timeline.label")}
        </button>
        <button
          type="button"
          className={`mx-4 w-full py-2 text-center smart-capitalize ${selected == "events" ? "rounded-lg bg-secondary" : ""}`}
          aria-pressed={selected == "events"}
          onClick={() => {
            onSelect("events");
            setDrawer(false);
          }}
        >
          {t("events.label")}
        </button>
        <button
          type="button"
          className={`mx-4 w-full py-2 text-center smart-capitalize ${selected == "detail" ? "rounded-lg bg-secondary" : ""}`}
          aria-pressed={selected == "detail"}
          onClick={() => {
            onSelect("detail");
            setDrawer(false);
          }}
        >
          {t("detail.label")}
        </button>
      </DrawerContent>
    </Drawer>
  );
}
