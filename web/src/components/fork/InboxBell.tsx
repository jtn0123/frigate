import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import { isDesktop } from "react-device-detect";
import {
  LuBell,
  LuBellOff,
  LuCheckCheck,
  LuSettings2,
  LuTrash2,
  LuX,
} from "react-icons/lu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import TimeAgo from "@/components/dynamic/TimeAgo";
import ForkNavButton, {
  type ForkNavVariant,
} from "@/components/fork/ForkNavButton";
import { forkNavIconClass } from "@/lib/fork/nav-icon";
import { baseUrl } from "@/api/baseUrl";
import { cn } from "@/lib/utils";
import { getTranslatedLabel } from "@/utils/i18n";
import { resolveCameraName } from "@/hooks/use-camera-friendly-name";
import { useAllowedCameras } from "@/hooks/use-allowed-cameras";
import {
  useInbox,
  useInboxCollector,
  useInboxUnreadCount,
} from "@/hooks/fork/use-inbox";
import {
  clearInbox,
  isInQuietHours,
  markAllInboxRead,
  markInboxRead,
  removeInboxItem,
  setCameraMuted,
  setQuietHours,
  type InboxItem,
} from "@/lib/fork/inbox-store";
import { FrigateConfig } from "@/types/frigateConfig";

type InboxBellProps = {
  variant: ForkNavVariant;
  large?: boolean;
};

/**
 * Bell with unread badge that opens the notification inbox panel. Also hosts
 * the WebSocket collector so items are gathered on every page.
 */
export default function InboxBell({ variant, large }: InboxBellProps) {
  const { t } = useTranslation(["fork"]);
  const [open, setOpen] = useState(false);
  const unread = useInboxUnreadCount();
  const { settings } = useInbox();

  useInboxCollector();

  const quiet = isInQuietHours(settings.quietHours);

  const Container = isDesktop ? Sheet : Drawer;
  const Trigger = isDesktop ? SheetTrigger : DrawerTrigger;
  const Content = isDesktop ? SheetContent : DrawerContent;
  const Header = isDesktop ? SheetHeader : DrawerHeader;
  const Title = isDesktop ? SheetTitle : DrawerTitle;
  const Description = isDesktop ? SheetDescription : DrawerDescription;

  return (
    <Container open={open} onOpenChange={setOpen}>
      <Trigger asChild>
        <ForkNavButton
          variant={variant}
          large={large}
          label={
            unread > 0
              ? t("inbox.openWithUnread", { count: unread })
              : t("inbox.open")
          }
          data-testid="inbox-bell"
        >
          {quiet ? (
            <LuBellOff className={forkNavIconClass(large)} />
          ) : (
            <LuBell className={forkNavIconClass(large)} />
          )}
          {unread > 0 && (
            <span
              data-testid="inbox-unread"
              className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-selected px-1 text-[10px] font-bold leading-none text-white"
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </ForkNavButton>
      </Trigger>
      <Content
        className={cn(
          "flex flex-col gap-0 p-0",
          isDesktop ? "w-[26rem] sm:max-w-[26rem]" : "max-h-[85dvh]",
        )}
        data-testid="inbox-panel"
      >
        <Header className="border-b px-4 py-3 text-left">
          <Title>{t("inbox.title")}</Title>
          <Description className="sr-only">
            {t("inbox.description")}
          </Description>
        </Header>
        <InboxPanelBody
          onNavigate={() => {
            setOpen(false);
          }}
        />
      </Content>
    </Container>
  );
}

type InboxPanelBodyProps = {
  onNavigate: () => void;
};

function InboxPanelBody({ onNavigate }: InboxPanelBodyProps) {
  const { t } = useTranslation(["fork"]);
  const navigate = useNavigate();
  const { data: config } = useSWR<FrigateConfig>("config", {
    revalidateOnFocus: false,
  });
  const { items, settings } = useInbox();
  const unread = useInboxUnreadCount();
  const [showSettings, setShowSettings] = useState(false);

  const openItem = useCallback(
    (item: InboxItem) => {
      markInboxRead(item.id);
      onNavigate();
      navigate(`/review?id=${encodeURIComponent(item.id)}`);
    },
    [navigate, onNavigate],
  );

  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
        <span className="text-sm text-muted-foreground">
          {unread > 0
            ? t("inbox.unreadCount", { count: unread })
            : t("inbox.allRead")}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("inbox.markAllRead")}
            disabled={unread === 0}
            onClick={markAllInboxRead}
          >
            <LuCheckCheck className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("inbox.clear")}
            disabled={items.length === 0}
            onClick={clearInbox}
          >
            <LuTrash2 className="size-4" />
          </Button>
          <Button
            variant={showSettings ? "select" : "ghost"}
            size="sm"
            aria-label={t("inbox.settings.title")}
            aria-pressed={showSettings}
            onClick={() => setShowSettings((v) => !v)}
          >
            <LuSettings2 className="size-4" />
          </Button>
        </div>
      </div>
      {showSettings && <InboxSettingsSection />}
      <div className="scrollbar-container flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            {t("inbox.empty")}
          </div>
        ) : (
          <ul className="flex flex-col gap-1 p-2">
            {items.map((item) => (
              <li
                key={item.id}
                data-testid="inbox-item"
                data-read={item.read ? "true" : "false"}
                className={cn(
                  "flex items-start gap-2 rounded-lg p-2",
                  !item.read && "bg-secondary/60",
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 gap-3 text-left"
                  aria-label={t("inbox.openItem", {
                    camera: resolveCameraName(config, item.camera),
                  })}
                  onClick={() => openItem(item)}
                >
                  <img
                    src={`${baseUrl}${item.thumbPath.replace("/media/frigate/", "")}`}
                    alt=""
                    loading="lazy"
                    className="h-14 w-[5.5rem] shrink-0 rounded-md bg-secondary object-cover"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      {!item.read && (
                        <span className="size-2 shrink-0 rounded-full bg-selected" />
                      )}
                      <span className="truncate text-sm font-medium smart-capitalize">
                        {resolveCameraName(config, item.camera)}
                      </span>
                      <Badge
                        variant={
                          item.severity === "alert"
                            ? "destructive"
                            : "secondary"
                        }
                        className="px-1.5 py-0 text-[10px]"
                      >
                        {t(`inbox.severity.${item.severity}`)}
                      </Badge>
                    </div>
                    <span className="truncate text-xs text-muted-foreground smart-capitalize">
                      {item.labels.length > 0
                        ? item.labels
                            .map((label) => getTranslatedLabel(label))
                            .join(", ")
                        : t("inbox.noLabels")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      <TimeAgo time={item.startTime * 1000} dense />
                    </span>
                  </div>
                </button>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={t("inbox.dismiss")}
                  onClick={() => removeInboxItem(item.id)}
                >
                  <LuX className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {settings.quietHours.enabled && (
        <div className="border-t px-4 py-2 text-xs text-muted-foreground">
          {t("inbox.quietHours.active", {
            start: settings.quietHours.start,
            end: settings.quietHours.end,
          })}
        </div>
      )}
    </>
  );
}

function InboxSettingsSection() {
  const { t } = useTranslation(["fork"]);
  const { data: config } = useSWR<FrigateConfig>("config", {
    revalidateOnFocus: false,
  });
  const cameras = useAllowedCameras();
  const { settings } = useInbox();

  const cameraRows = useMemo(
    () =>
      cameras.map((name) => ({
        name,
        label: resolveCameraName(config, name),
        muted: settings.mutedCameras.includes(name),
      })),
    [cameras, config, settings.mutedCameras],
  );

  return (
    <div
      className="flex flex-col gap-4 border-b px-4 py-3"
      data-testid="inbox-settings"
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="inbox-quiet-enabled" className="text-sm font-medium">
            {t("inbox.quietHours.title")}
          </Label>
          <Switch
            id="inbox-quiet-enabled"
            checked={settings.quietHours.enabled}
            onCheckedChange={(enabled) =>
              setQuietHours({ ...settings.quietHours, enabled })
            }
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t("inbox.quietHours.description")}
        </p>
        <div className="flex items-center gap-2">
          <Label htmlFor="inbox-quiet-start" className="w-10 text-xs">
            {t("inbox.quietHours.start")}
          </Label>
          <Input
            id="inbox-quiet-start"
            type="time"
            className="h-8 w-28"
            value={settings.quietHours.start}
            disabled={!settings.quietHours.enabled}
            onChange={(e) =>
              setQuietHours({ ...settings.quietHours, start: e.target.value })
            }
          />
          <Label htmlFor="inbox-quiet-end" className="w-10 text-xs">
            {t("inbox.quietHours.end")}
          </Label>
          <Input
            id="inbox-quiet-end"
            type="time"
            className="h-8 w-28"
            value={settings.quietHours.end}
            disabled={!settings.quietHours.enabled}
            onChange={(e) =>
              setQuietHours({ ...settings.quietHours, end: e.target.value })
            }
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t("inbox.mute.title")}</span>
        <p className="text-xs text-muted-foreground">
          {t("inbox.mute.description")}
        </p>
        {cameraRows.map((camera) => (
          <div
            key={camera.name}
            className="flex items-center justify-between gap-2"
          >
            <Label
              htmlFor={`inbox-mute-${camera.name}`}
              className="truncate text-sm smart-capitalize"
            >
              {camera.label}
            </Label>
            <Switch
              id={`inbox-mute-${camera.name}`}
              aria-label={t("inbox.mute.camera", { camera: camera.label })}
              checked={camera.muted}
              onCheckedChange={(muted) => setCameraMuted(camera.name, muted)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
