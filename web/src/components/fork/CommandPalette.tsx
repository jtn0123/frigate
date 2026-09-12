import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import useSWR from "swr";
import axios from "axios";
import { toast } from "sonner";
import { isDesktop } from "react-device-detect";
import type { IconType } from "react-icons";
import { FaCompactDisc, FaVideo } from "react-icons/fa";
import { IoSearch } from "react-icons/io5";
import { MdCategory, MdChat, MdVideoLibrary } from "react-icons/md";
import { TbFaceId } from "react-icons/tb";
import {
  LuActivity,
  LuCheckCheck,
  LuFileCode,
  LuHistory,
  LuLayers,
  LuList,
  LuRotateCw,
  LuSettings,
  LuSunMoon,
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
import { isForkEnabled } from "@/fork/flags";
import { FrigateConfig } from "@/types/frigateConfig";
import { ReviewSegment } from "@/types/review";
import { ENV } from "@/env";

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
  const { data: config } = useSWR<FrigateConfig>("config", {
    revalidateOnFocus: false,
  });
  const allowedCameras = useAllowedCameras();
  const { theme, systemTheme, setTheme } = useTheme();
  const { send: sendRestart } = useRestart();
  const mutate = useGlobalMutation();

  const [open, setOpen] = useCommandPaletteOpen();
  const [search, setSearch] = useState("");
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [recent, pushRecent] = useRecentCommands();

  useCommandPaletteShortcuts();

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
        icon: FaVideo,
      },
      {
        id: "page:review",
        label: t("menu.review", { ns: "common" }),
        to: "/review",
        icon: MdVideoLibrary,
      },
      {
        id: "page:explore",
        label: t("menu.explore", { ns: "common" }),
        to: "/explore",
        icon: IoSearch,
      },
      {
        id: "page:export",
        label: t("menu.export", { ns: "common" }),
        to: "/export",
        icon: FaCompactDisc,
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
        icon: TbFaceId,
        enabled: isDesktop && isAdmin && !!config?.face_recognition.enabled,
      },
      {
        id: "page:classification",
        label: t("menu.classification", { ns: "common" }),
        to: "/classification",
        icon: MdCategory,
        enabled: isDesktop && isAdmin,
      },
      {
        id: "page:chat",
        label: t("menu.chat", { ns: "common" }),
        to: "/chat",
        icon: MdChat,
        enabled: isDesktop && isAdmin && hasChatAgent,
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
    const go = (to: string) => () => navigate(to);
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
          icon: FaVideo,
          run: go(`/#${name}`),
        },
        {
          id: `camera:${name}:review`,
          group: "cameras",
          label,
          hint: t("commandPalette.camera.review"),
          keywords: [name, "review", "camera"],
          icon: MdVideoLibrary,
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
            </CommandList>
            <div className="flex items-center gap-3 border-t px-3 py-1.5 text-xs text-muted-foreground">
              <LuHistory className="size-3" />
              <span>{t("commandPalette.footerHint")}</span>
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
