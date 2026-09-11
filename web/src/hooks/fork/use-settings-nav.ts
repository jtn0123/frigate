/**
 * Fork: exposes the Settings page's navigation and pending-change state to
 * the fork components (section navigator, badges, review dialog) without
 * threading props through `pages/Settings.tsx`.
 *
 * `Settings` publishes with `useSettingsNavPublish` (one hook call) and the
 * fork components subscribe with `useSettingsNavStore`. A module store is
 * used instead of a context provider so the upstream page only needs a
 * single hunk rather than wrapping both of its return branches.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import useSWR from "swr";
import type { RJSFSchema } from "@rjsf/utils";
import { isForkEnabled } from "@/fork/flags";
import type { FrigateConfig } from "@/types/frigateConfig";
import type { ConfigSectionData } from "@/types/configForm";
import type { SectionStatus } from "@/views/settings/SingleSectionPage";
import {
  getSettingsDiff,
  type SettingsSectionDiff,
} from "@/lib/fork/settings-diff";

export type SettingsNavGroup = {
  label: string;
  items: ReadonlyArray<{ key: string }>;
};

export type SettingsNavPublished = {
  /** Menu key of the section currently shown. */
  page: string;
  setPage: (key: string) => void;
  /** Mobile only: opens the content pane after a jump. */
  setContentOpen: (open: boolean) => void;
  groups: ReadonlyArray<SettingsNavGroup>;
  visibleKeys: ReadonlyArray<string>;
  pendingDataBySection: Record<string, ConfigSectionData>;
  sectionStatusByKey: Partial<Record<string, SectionStatus>>;
  pendingKeyToMenuKey: (pendingKey: string) => string | undefined;
  saveAll: () => void;
  saveDisabled: boolean;
};

type Store = {
  published: SettingsNavPublished | null;
  reviewOpen: boolean;
  /** Number of mounted review-dialog hosts; Save All bypasses when zero. */
  hosts: number;
};

let store: Store = { published: null, reviewOpen: false, hosts: 0 };
const listeners = new Set<() => void>();

function setStore(patch: Partial<Store>) {
  store = { ...store, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return store;
}

export function useSettingsNavStore() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function setSettingsReviewOpen(open: boolean) {
  setStore({ reviewOpen: open });
}

export function registerSettingsReviewHost() {
  setStore({ hosts: store.hosts + 1 });
  return () => setStore({ hosts: Math.max(0, store.hosts - 1) });
}

/**
 * Called once from `Settings`. Returns `requestSaveAll`, which opens the
 * review dialog when the flag is on (and a host is mounted) and otherwise
 * runs the upstream Save All directly.
 */
export function useSettingsNavPublish(state: SettingsNavPublished) {
  const {
    page,
    setPage,
    setContentOpen,
    groups,
    visibleKeys,
    pendingDataBySection,
    sectionStatusByKey,
    pendingKeyToMenuKey,
    saveAll,
    saveDisabled,
  } = state;

  useEffect(() => {
    setStore({
      published: {
        page,
        setPage,
        setContentOpen,
        groups,
        visibleKeys,
        pendingDataBySection,
        sectionStatusByKey,
        pendingKeyToMenuKey,
        saveAll,
        saveDisabled,
      },
    });
  }, [
    page,
    setPage,
    setContentOpen,
    groups,
    visibleKeys,
    pendingDataBySection,
    sectionStatusByKey,
    pendingKeyToMenuKey,
    saveAll,
    saveDisabled,
  ]);

  useEffect(() => () => setStore({ published: null, reviewOpen: false }), []);

  const requestSaveAll = useCallback(() => {
    if (isForkEnabled("settingsNav") && store.hosts > 0) {
      setStore({ reviewOpen: true });
      return;
    }
    saveAll();
  }, [saveAll]);

  return { requestSaveAll };
}

const EMPTY_PENDING: Record<string, ConfigSectionData> = {};

/** Readable diff of the pending changes, memoized on input identity. */
export function useSettingsDiff(): SettingsSectionDiff[] {
  const { published } = useSettingsNavStore();
  const enabled = isForkEnabled("settingsNav") && !!published;
  const { data: config } = useSWR<FrigateConfig>(enabled ? "config" : null);
  const { data: fullSchema } = useSWR<RJSFSchema>(
    enabled ? "config/schema.json" : null,
  );
  const pending = published?.pendingDataBySection ?? EMPTY_PENDING;

  return useMemo(
    () => (enabled ? getSettingsDiff(pending, config, fullSchema) : []),
    [enabled, pending, config, fullSchema],
  );
}
