/**
 * Fork: section navigator for the Settings page.
 *
 * Mounted at the top of the settings content column. Provides:
 * - a search box that filters sections by title and, for the section on
 *   screen, by the field labels it renders;
 * - on desktop, a sticky scrollspy rail listing the field groups of the
 *   current section (`[data-settings-anchor]` elements) with the one in
 *   view highlighted;
 * - on mobile, a compact select that jumps between sections;
 * - the "Review changes" dialog that Save All opens.
 *
 * State comes from `useSettingsNavStore`, published by `pages/Settings`.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { isMobile } from "react-device-detect";
import { LuCheck, LuCornerDownRight } from "react-icons/lu";
import { isForkEnabled } from "@/fork/flags";
import { useSettingsNavStore } from "@/hooks/fork/use-settings-nav";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import SettingsReviewDialog from "./SettingsReviewDialog";

type FieldMatch = {
  key: string;
  label: string;
  element: HTMLElement;
};

type Anchor = {
  key: string;
  label: string;
  element: HTMLElement;
};

const HIGHLIGHT_CLASSES = ["ring-2", "ring-selected", "rounded-md"];
const HIGHLIGHT_ATTR = "data-settings-nav-highlight";

function readLabel(element: HTMLElement) {
  return element.textContent.replace(/\*\s*$/, "").trim();
}

/** Scroll an element into view inside the settings content and flash it. */
function revealElement(element: HTMLElement) {
  const target =
    (element.closest("[data-field-id]") as HTMLElement | null) ?? element;
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  target.classList.add(...HIGHLIGHT_CLASSES);
  target.setAttribute(HIGHLIGHT_ATTR, "true");
  window.setTimeout(() => {
    target.classList.remove(...HIGHLIGHT_CLASSES);
    target.removeAttribute(HIGHLIGHT_ATTR);
  }, 1600);
  if (element instanceof HTMLLabelElement && element.htmlFor) {
    document.getElementById(element.htmlFor)?.focus({ preventScroll: true });
  }
}

type SettingsNavProps = {
  className?: string;
};

export default function SettingsNav({ className }: SettingsNavProps) {
  const { t } = useTranslation(["fork", "views/settings"]);
  const { published } = useSettingsNavStore();
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<FieldMatch[]>([]);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);

  const enabled = isForkEnabled("settingsNav") && !!published;

  // The scrollable settings content is the navigator's parent element.
  const getContainer = useCallback(
    () => rootRef.current?.parentElement ?? null,
    [],
  );

  const groups = useMemo(() => {
    if (!published) return [];
    const visible = new Set(published.visibleKeys);
    return published.groups
      .map((group) => ({
        label: group.label,
        keys: group.items
          .map((item) => item.key)
          .filter((key) => visible.has(key)),
      }))
      .filter((group) => group.keys.length > 0);
  }, [published]);

  const sectionTitle = useCallback(
    (key: string) => t(`menu.${key}`, { ns: "views/settings" }),
    [t],
  );

  const scanFields = useCallback((): FieldMatch[] => {
    const container = getContainer();
    const root = rootRef.current;
    if (!container || !root) return [];
    const seen = new Set<string>();
    const out: FieldMatch[] = [];
    container.querySelectorAll<HTMLElement>("label").forEach((element) => {
      if (root.contains(element)) return;
      const label = readLabel(element);
      if (!label) return;
      const key = `${label}::${element.getAttribute("for") ?? out.length}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ key, label, element });
    });
    return out;
  }, [getContainer]);

  const scanAnchors = useCallback((): Anchor[] => {
    const container = getContainer();
    const root = rootRef.current;
    if (!container || !root) return [];
    const out: Anchor[] = [];
    container
      .querySelectorAll<HTMLElement>("[data-settings-anchor]")
      .forEach((element, index) => {
        if (root.contains(element)) return;
        const label = readLabel(element);
        if (!label) return;
        out.push({
          key: `${element.getAttribute("data-settings-anchor")}-${index}`,
          label,
          element,
        });
      });
    return out;
  }, [getContainer]);

  // Keep the rail in sync with the rendered form: sections render after the
  // schema loads and collapsibles add or remove groups, so watch the DOM.
  const page = published?.page;
  useEffect(() => {
    if (!enabled || isMobile) return;
    const container = getContainer();
    if (!container) return;
    let frame = 0;
    const refresh = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => setAnchors(scanAnchors()));
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [enabled, page, getContainer, scanAnchors]);

  // Scrollspy: the active anchor is the last one above the top of the
  // scroll container (with a small offset for the sticky bar).
  useEffect(() => {
    if (!enabled || isMobile || anchors.length === 0) {
      setActiveAnchor(null);
      return;
    }
    const container = getContainer();
    if (!container) return;
    const update = () => {
      const top = container.getBoundingClientRect().top + 96;
      let current: Anchor | null = null;
      for (const anchor of anchors) {
        if (anchor.element.getBoundingClientRect().top <= top) {
          current = anchor;
        } else {
          break;
        }
      }
      const fallback = anchors.at(0);
      if (fallback === undefined) {
        setActiveAnchor(null);
        return;
      }
      setActiveAnchor((current ?? fallback).key);
    };
    update();
    container.addEventListener("scroll", update, { passive: true });
    return () => container.removeEventListener("scroll", update);
  }, [enabled, anchors, getContainer]);

  // Close the search dropdown on outside clicks (works for touch too).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const jumpToSection = useCallback(
    (key: string) => {
      if (!published) return;
      published.setPage(key);
      if (isMobile) {
        published.setContentOpen(true);
      }
      setOpen(false);
      setQuery("");
      getContainer()?.scrollTo({ top: 0 });
    },
    [published, getContainer],
  );

  const jumpToField = useCallback((field: FieldMatch) => {
    setOpen(false);
    setQuery("");
    revealElement(field.element);
  }, []);

  const jumpToAnchor = useCallback((anchor: Anchor) => {
    revealElement(anchor.element);
  }, []);

  const needle = query.trim().toLowerCase();
  const fieldMatches = useMemo(
    () =>
      needle
        ? fields.filter((field) => field.label.toLowerCase().includes(needle))
        : [],
    [fields, needle],
  );
  const sectionMatches = useMemo(
    () =>
      groups
        .map((group) => ({
          label: group.label,
          keys: group.keys.filter(
            (key) =>
              !needle || sectionTitle(key).toLowerCase().includes(needle),
          ),
        }))
        .filter((group) => group.keys.length > 0),
    [groups, needle, sectionTitle],
  );

  if (!published) {
    return null;
  }
  if (!isForkEnabled("settingsNav")) {
    return null;
  }

  const unsavedDot = (key: string): ReactNode =>
    published.sectionStatusByKey[key]?.hasChanges ? (
      <span
        className="ml-2 inline-block size-2 shrink-0 rounded-full bg-unsaved"
        aria-label={t("settingsNav.unsaved")}
      />
    ) : null;

  const search = (
    <Command
      shouldFilter={false}
      loop
      className="relative w-full overflow-visible rounded-md border border-secondary bg-background md:max-w-md"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          setQuery("");
          (event.target as HTMLElement).blur();
        }
      }}
    >
      <CommandInput
        className="h-9"
        placeholder={t("settingsNav.searchPlaceholder")}
        aria-label={t("settingsNav.searchLabel")}
        data-testid="settings-nav-search"
        value={query}
        onValueChange={(value) => {
          setQuery(value);
          setFields(scanFields());
          setOpen(true);
        }}
        onFocus={() => {
          setFields(scanFields());
          setOpen(true);
        }}
      />
      {open && (
        <CommandList
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-80 rounded-md border border-secondary bg-background shadow-lg"
          data-testid="settings-nav-results"
        >
          <CommandEmpty>{t("settingsNav.noMatches")}</CommandEmpty>
          {fieldMatches.length > 0 && (
            <CommandGroup heading={t("settingsNav.inThisSection")}>
              {fieldMatches.map((field) => (
                <CommandItem
                  key={field.key}
                  value={`field:${field.key}`}
                  onSelect={() => jumpToField(field)}
                  className="cursor-pointer"
                  data-testid="settings-nav-field"
                >
                  <LuCornerDownRight className="mr-2 size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{field.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {sectionMatches.map((group) => (
            <CommandGroup
              key={group.label}
              heading={t(`menu.${group.label}`, { ns: "views/settings" })}
            >
              {group.keys.map((key) => (
                <CommandItem
                  key={key}
                  value={`section:${key}`}
                  onSelect={() => jumpToSection(key)}
                  className="cursor-pointer"
                  data-testid="settings-nav-section"
                  data-section-key={key}
                >
                  <span className="truncate">{sectionTitle(key)}</span>
                  {unsavedDot(key)}
                  {key === published.page && (
                    <LuCheck className="ml-auto size-4 shrink-0 text-selected" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      )}
    </Command>
  );

  const mobileSelect = (
    <Select value={published.page} onValueChange={jumpToSection}>
      <SelectTrigger
        className="h-9 w-full"
        aria-label={t("settingsNav.sectionLabel")}
        data-testid="settings-nav-select"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-[60dvh]">
        {groups.map((group) => (
          <SelectGroup key={group.label}>
            <SelectLabel>
              {t(`menu.${group.label}`, { ns: "views/settings" })}
            </SelectLabel>
            {group.keys.map((key) => (
              <SelectItem key={key} value={key}>
                {sectionTitle(key)}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );

  const rail = anchors.length > 0 && (
    <nav
      aria-label={t("settingsNav.onThisPage")}
      data-testid="settings-nav-rail"
      className="absolute right-4 top-full mt-2 hidden w-52 rounded-md border border-secondary bg-background/95 p-2 text-sm backdrop-blur 2xl:block"
    >
      <div className="mb-1 px-2 text-xs font-medium uppercase text-muted-foreground">
        {t("settingsNav.onThisPage")}
      </div>
      <ul className="flex max-h-[60dvh] flex-col gap-0.5 overflow-y-auto">
        {anchors.map((anchor) => (
          <li key={anchor.key}>
            <button
              type="button"
              onClick={() => jumpToAnchor(anchor)}
              data-active={anchor.key === activeAnchor}
              className={cn(
                "w-full truncate rounded-md px-2 py-1 text-left text-muted-foreground hover:bg-secondary hover:text-primary",
                anchor.key === activeAnchor &&
                  "bg-secondary font-medium text-primary",
              )}
            >
              {anchor.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );

  return (
    <div
      ref={rootRef}
      data-testid="settings-nav"
      className={cn(
        "z-30 mb-3 bg-background md:sticky md:top-0 md:pb-2",
        className,
      )}
    >
      <div className="flex flex-col gap-2">
        {isMobile && mobileSelect}
        {search}
      </div>
      {!isMobile && rail}
      <SettingsReviewDialog />
    </div>
  );
}
