import { useCallback, useEffect, useMemo, useState } from "react";
import { isApplePlatform } from "@/lib/fork/platform";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useApi } from "@/api/fork/client";
import axios from "axios";
import { toast } from "sonner";
import { isDesktop } from "react-device-detect";
import type { IconType } from "react-icons";
// fork (UI132): the palette names the same destinations as the rail, so it
// draws them with the same icons.
import {
  LuActivity,
  LuArrowRight,
  LuCheckCheck,
  LuFileCode,
  LuFilm,
  LuGalleryThumbnails,
  LuHistory,
  LuLayers,
  LuList,
  LuMessageCircle,
  LuRotateCw,
  LuSearch,
  LuSettings,
  LuShapes,
  LuSparkles,
  LuSunMoon,
  LuUsersRound,
  LuVideo,
} from "react-icons/lu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import RestartDialog from "@/components/overlay/dialog/RestartDialog";
import { useRestart } from "@/api/ws";
import { useTheme } from "@/context/theme-provider";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useAllowedCameras } from "@/hooks/use-allowed-cameras";
import useGlobalMutation from "@/hooks/use-global-mutate";
import { resolveCameraName } from "@/hooks/use-camera-friendly-name";
import {
  useCommandPaletteOpen,
  useCommandPaletteShortcuts,
  useRecentCommands,
} from "@/hooks/fork/use-command-palette";
import {
  SETTINGS_SECTIONS,
  VIEWER_SETTINGS_SECTIONS,
} from "@/lib/fork/command-items";
import { WHATS_NEW_EVENT } from "@/lib/fork/updates";
import { isForkEnabled } from "@/fork/flags";
import { ReviewSegment } from "@/types/review";
import { ENV } from "@/env";
import { phoneFixes } from "@/lib/fork/phone";
import { useApiHost } from "@/api";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import { useTimeFormat, useTimezone } from "@/hooks/use-date-utils";
import {
  MIN_FOOTAGE_QUERY,
  useFootageSearch,
} from "@/hooks/fork/use-footage-search";
import { getTranslatedLabel } from "@/utils/i18n";
import { formatUnixTimestampToDateTime } from "@/utils/dateUtil";

// Face Library, Classification and Chat are left out of the phone nav bar
// for space; with phoneFixes the palette is how phones reach them.
const allPages = isDesktop || phoneFixes;

type PaletteGroup =
  "pages" | "cameras" | "cameraGroups" | "settings" | "actions";

type PaletteItem = {
  id: string;
  group: PaletteGroup;
  label: string;
  hint?: string;
  keywords: string[];
  icon: IconType;
  run: () => void;
};

const GROUP_ORDER: PaletteGroup[] = [
  "pages",
  "cameras",
  "cameraGroups",
  "settings",
  "actions",
];

/**
 * Cmd/Ctrl+K command palette. Mounted once from App.tsx; opened from the
 * keyboard shortcuts or the ForkNavItems buttons.
 */
export default function CommandPalette() {
  if (!isForkEnabled("commandPalette")) {
    return null;
  }
  return <CommandPaletteInner />;
}

function CommandPaletteInner() {
  const { t } = useTranslation(["fork", "common", "views/settings"]);
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  const { data: config } = useApi("/config", {
    revalidateOnFocus: false,
  });
  const allowedCameras = useAllowedCameras();
  const apiHost = useApiHost();
  const timezone = useTimezone(config);
  const timeFormat = useTimeFormat(config);
  const { theme, systemTheme, setTheme } = useTheme();
  const { send: sendRestart } = useRestart();
  const mutate = useGlobalMutation();

  const [open, setOpen] = useCommandPaletteOpen();
  const [search, setSearch] = useState("");
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [recent, pushRecent] = useRecentCommands();

  useCommandPaletteShortcuts();

  // fork (UI134): the same box searches recorded footage. `/events/search` is
  // the semantic endpoint and answers 400 when semantic search is off, so the
  // request is gated on the config rather than left to fail.
  const semanticEnabled = config?.semantic_search.enabled === true;
  const footage = useFootageSearch(search, open && semanticEnabled);
  const typedEnough = search.trim().length >= MIN_FOOTAGE_QUERY;
  const showFootage = typedEnough && semanticEnabled;
  // without the semantic endpoint there is nothing to search, so the tab
  // says so once rather than answering every query with an empty group
  const showFootageSetup = typedEnough && !semanticEnabled && isAdmin;

  useEffect(() => {
    if (!open) {
      setSearch("");
    }
  }, [open]);

  const hasChatAgent = useMemo(
    () =>
      Object.values(config?.genai ?? {}).some((agent) =>
        agent.roles.includes("chat"),
      ),
    [config?.genai],
  );

  const toggleTheme = useCallback(() => {
    const active = theme === "system" ? systemTheme : theme;
    setTheme(active === "dark" ? "light" : "dark");
  }, [theme, systemTheme, setTheme]);

  const markAllReviewed = useCallback(async () => {
    try {
      const resp = await axios.get<ReviewSegment[]>("review", {
        params: { reviewed: 0 },
      });
      const ids = resp.data.filter((seg) => seg.end_time).map((seg) => seg.id);
      if (ids.length === 0) {
        toast.info(t("commandPalette.toast.nothingToReview"), {
          position: "top-center",
        });
        return;
      }
      await axios.post("reviews/viewed", { ids, reviewed: true });
      await mutate((key) => typeof key === "string" && key.includes("review"));
      toast.success(
        t("commandPalette.toast.markedReviewed", { count: ids.length }),
        { position: "top-center" },
      );
    } catch {
      toast.error(t("commandPalette.toast.markFailed"), {
        position: "top-center",
      });
    }
  }, [mutate, t]);

  // Kept out of the items memo below so that callback stays readable.
  const pages = useMemo<
    Array<{
      id: string;
      label: string;
      to: string;
      icon: IconType;
      enabled?: boolean;
    }>
  >(
    () => [
      {
        id: "page:live",
        label: t("menu.live.title", { ns: "common" }),
        to: "/",
        icon: LuVideo,
      },
      {
        id: "page:review",
        label: t("menu.review", { ns: "common" }),
        to: "/review",
        icon: LuGalleryThumbnails,
      },
      {
        id: "page:explore",
        label: t("menu.explore", { ns: "common" }),
        to: "/explore",
        icon: LuSearch,
      },
      {
        id: "page:export",
        label: t("menu.export", { ns: "common" }),
        to: "/export",
        icon: LuFilm,
      },
      {
        id: "page:system",
        label: t("menu.systemMetrics", { ns: "common" }),
        to: "/system#general",
        icon: LuActivity,
        enabled: isAdmin,
      },
      {
        id: "page:settings",
        label: t("menu.settings", { ns: "common" }),
        to: "/settings",
        icon: LuSettings,
      },
      {
        id: "page:config",
        label: t("menu.configurationEditor", { ns: "common" }),
        to: "/config",
        icon: LuFileCode,
        enabled: isAdmin,
      },
      {
        id: "page:logs",
        label: t("menu.systemLogs", { ns: "common" }),
        to: "/logs",
        icon: LuList,
        enabled: isAdmin,
      },
      {
        id: "page:faces",
        label: t("menu.faceLibrary", { ns: "common" }),
        to: "/faces",
        icon: LuUsersRound,
        enabled: allPages && isAdmin && !!config?.face_recognition.enabled,
      },
      {
        id: "page:classification",
        label: t("menu.classification", { ns: "common" }),
        to: "/classification",
        icon: LuShapes,
        enabled: allPages && isAdmin,
      },
      {
        id: "page:chat",
        label: t("menu.chat", { ns: "common" }),
        to: "/chat",
        icon: LuMessageCircle,
        enabled: allPages && isAdmin && hasChatAgent,
      },
      {
        id: "page:playground",
        label: t("menu.uiPlayground", { ns: "common" }),
        to: "/playground",
        icon: LuActivity,
        enabled: ENV !== "production" && isAdmin,
      },
    ],
    [t, isAdmin, config, hasChatAgent],
  );

  const items = useMemo<PaletteItem[]>(() => {
    const go = (to: string) => () => void navigate(to);
    const list: PaletteItem[] = [];

    for (const page of pages) {
      if (page.enabled === false) continue;
      list.push({
        id: page.id,
        group: "pages",
        label: page.label,
        keywords: [page.to],
        icon: page.icon,
        run: go(page.to),
      });
    }

    for (const name of allowedCameras) {
      const camera = config?.cameras[name];
      if (!camera) continue;
      const label = resolveCameraName(config, name);
      list.push(
        {
          id: `camera:${name}:live`,
          group: "cameras",
          label,
          hint: t("commandPalette.camera.live"),
          keywords: [name, "live", "camera"],
          icon: LuVideo,
          run: go(`/#${name}`),
        },
        {
          id: `camera:${name}:review`,
          group: "cameras",
          label,
          hint: t("commandPalette.camera.review"),
          keywords: [name, "review", "camera"],
          icon: LuGalleryThumbnails,
          run: go(`/review?cameras=${encodeURIComponent(name)}`),
        },
      );
    }

    for (const groupName of Object.keys(config?.camera_groups ?? {})) {
      list.push({
        id: `group:${groupName}`,
        group: "cameraGroups",
        label: groupName,
        keywords: ["group", "cameras"],
        icon: LuLayers,
        run: go(`/?group=${encodeURIComponent(groupName)}`),
      });
    }

    for (const section of SETTINGS_SECTIONS) {
      if (!isAdmin && !VIEWER_SETTINGS_SECTIONS.includes(section.key)) {
        continue;
      }
      list.push({
        id: `settings:${section.key}`,
        group: "settings",
        label: t(`menu.${section.key}`, { ns: "views/settings" }),
        hint: t(`menu.${section.group}`, { ns: "views/settings" }),
        keywords: [section.key, "settings"],
        icon: LuSettings,
        run: go(`/settings?page=${section.key}`),
      });
    }

    list.push(
      {
        id: "action:toggleTheme",
        group: "actions",
        label: t("commandPalette.actions.toggleTheme"),
        keywords: ["dark", "light", "theme", "appearance"],
        icon: LuSunMoon,
        run: toggleTheme,
      },
      {
        id: "action:markAllReviewed",
        group: "actions",
        label: t("commandPalette.actions.markAllReviewed"),
        keywords: ["review", "reviewed", "alerts", "detections"],
        icon: LuCheckCheck,
        run: () => {
          void markAllReviewed(); // palette run() cannot be async
        },
      },
    );
    if (isForkEnabled("updateNotices")) {
      list.push({
        id: "action:whatsNew",
        group: "actions",
        label: t("commandPalette.actions.whatsNew"),
        keywords: ["release", "notes", "changelog", "update", "version"],
        icon: LuSparkles,
        run: () => window.dispatchEvent(new Event(WHATS_NEW_EVENT)),
      });
    }
    if (isAdmin) {
      list.push({
        id: "action:restart",
        group: "actions",
        label: t("menu.restart", { ns: "common" }),
        keywords: ["restart", "reboot"],
        icon: LuRotateCw,
        run: () => setRestartDialogOpen(true),
      });
    }

    return list;
  }, [
    t,
    navigate,
    pages,
    isAdmin,
    config,
    allowedCameras,
    toggleTheme,
    markAllReviewed,
  ]);

  const recentItems = useMemo(
    () =>
      recent
        .map((id) => items.find((item) => item.id === id))
        .filter((item): item is PaletteItem => item !== undefined),
    [recent, items],
  );

  const runItem = useCallback(
    (item: PaletteItem) => {
      pushRecent(item.id);
      setOpen(false);
      item.run();
    },
    [pushRecent, setOpen],
  );

  // Footage rows are not PaletteItems: they carry a thumbnail, they come from
  // the network, and they are never worth remembering as a recent command.
  const goFootage = useCallback(
    (to: string) => {
      setOpen(false);
      void navigate(to);
    },
    [navigate, setOpen],
  );

  const renderItem = (item: PaletteItem, valuePrefix = "") => {
    const Icon = item.icon;
    return (
      <CommandItem
        key={`${valuePrefix}${item.id}`}
        value={`${valuePrefix}${item.id}`}
        keywords={[item.label, item.hint ?? "", ...item.keywords]}
        onSelect={() => runItem(item)}
        className="cursor-pointer gap-2"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{item.label}</span>
        {item.hint && <CommandShortcut>{item.hint}</CommandShortcut>}
      </CommandItem>
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="top-[15%] translate-y-0 overflow-hidden p-0 shadow-lg sm:max-w-lg"
          data-testid="command-palette"
        >
          <DialogTitle className="sr-only">
            {t("commandPalette.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("commandPalette.description")}
          </DialogDescription>
          <Command
            loop
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]]:px-2 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2.5"
          >
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder={t("commandPalette.placeholder")}
              aria-label={t("commandPalette.title")}
            />
            <CommandList className="max-h-[50vh]">
              <CommandEmpty>{t("commandPalette.empty")}</CommandEmpty>
              {search === "" && recentItems.length > 0 && (
                <CommandGroup heading={t("commandPalette.groups.recent")}>
                  {recentItems.map((item) => renderItem(item, "recent:"))}
                </CommandGroup>
              )}
              {/* fork (UI134): clips for the typed query, above the command
                  matches because the rail's magnifier now says this box
                  searches footage. The rows are already the answer to what was
                  typed, and a clip of a car does not contain the words "red
                  car", so they are force mounted rather than run through the
                  fuzzy filter a second time. */}
              {showFootage && (
                <CommandGroup
                  forceMount
                  heading={t("commandPalette.groups.footage")}
                >
                  {footage.results.map((result) => (
                    <CommandItem
                      key={result.id}
                      forceMount
                      value={`footage:${result.id}`}
                      onSelect={() =>
                        goFootage(`/explore?event_id=${result.id}`)
                      }
                      className="cursor-pointer gap-2"
                      data-testid="footage-result"
                    >
                      <img
                        src={`${apiHost}api/events/${result.id}/thumbnail.webp`}
                        alt=""
                        loading="lazy"
                        className="h-8 w-12 shrink-0 rounded bg-secondary object-cover"
                      />
                      <span className="truncate">
                        {t("commandPalette.footage.result", {
                          label: getTranslatedLabel(
                            result.sub_label || result.label,
                            result.data.type,
                          ),
                          camera: resolveCameraName(config, result.camera),
                        })}
                      </span>
                      <CommandShortcut>
                        {formatUnixTimestampToDateTime(result.start_time, {
                          // the config may not name one, and the style type
                          // takes an absent key rather than an undefined one
                          ...(timezone ? { timezone } : {}),
                          date_format: t(
                            `time.formattedTimestampMonthDayHourMinute.${timeFormat}`,
                            { ns: "common" },
                          ),
                        })}
                      </CommandShortcut>
                    </CommandItem>
                  ))}
                  {footage.isLoading && (
                    <CommandItem
                      disabled
                      forceMount
                      value="footage:loading"
                      className="gap-2 text-muted-foreground"
                    >
                      <ActivityIndicator className="size-4 shrink-0" />
                      <span>{t("commandPalette.footage.searching")}</span>
                    </CommandItem>
                  )}
                  {!footage.isLoading &&
                    footage.query !== "" &&
                    footage.results.length === 0 && (
                      <CommandItem
                        disabled
                        forceMount
                        value="footage:none"
                        className="gap-2 text-muted-foreground"
                      >
                        <LuSearch className="size-4 shrink-0" />
                        <span>{t("commandPalette.footage.none")}</span>
                      </CommandItem>
                    )}
                  {footage.results.length > 0 && (
                    <CommandItem
                      forceMount
                      value="footage:all"
                      onSelect={() =>
                        goFootage(
                          `/explore?query=${encodeURIComponent(search.trim())}`,
                        )
                      }
                      className="cursor-pointer gap-2"
                      data-testid="footage-see-all"
                    >
                      <LuArrowRight className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">
                        {t("commandPalette.footage.seeAll", {
                          query: search.trim(),
                        })}
                      </span>
                    </CommandItem>
                  )}
                </CommandGroup>
              )}
              {GROUP_ORDER.map((group) => {
                const groupItems = items.filter((item) => item.group === group);
                if (groupItems.length === 0) return null;
                return (
                  <CommandGroup
                    key={group}
                    heading={t(`commandPalette.groups.${group}`)}
                  >
                    {groupItems.map((item) => renderItem(item))}
                  </CommandGroup>
                );
              })}
              {/* the same group, in the quiet spot at the end: with no
                  semantic search there is nothing to search, and this is a
                  note rather than a result */}
              {showFootageSetup && (
                <CommandGroup
                  forceMount
                  heading={t("commandPalette.groups.footage")}
                >
                  <CommandItem
                    forceMount
                    value="footage:setup"
                    onSelect={() =>
                      goFootage("/settings?page=integrationSemanticSearch")
                    }
                    className="cursor-pointer gap-2"
                    data-testid="footage-setup"
                  >
                    <LuSearch className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">
                      {t("commandPalette.footage.needsSemanticSearch")}
                    </span>
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
            <div className="flex items-center gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground">
              <LuHistory className="size-3" />
              <span>
                {t(
                  isApplePlatform()
                    ? "commandPalette.footerHintMac"
                    : "commandPalette.footerHint",
                )}
              </span>
            </div>
          </Command>
        </DialogContent>
      </Dialog>
      <RestartDialog
        isOpen={restartDialogOpen}
        onClose={() => setRestartDialogOpen(false)}
        onRestart={() => sendRestart("restart")}
      />
    </>
  );
}
