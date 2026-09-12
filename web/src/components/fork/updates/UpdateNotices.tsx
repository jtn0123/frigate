import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import axios from "axios";
import { toast } from "sonner";
import { LuRocket } from "react-icons/lu";
import ForkNavButton, {
  type ForkNavVariant,
} from "@/components/fork/ForkNavButton";
import { forkNavIconClass } from "@/lib/fork/nav-icon";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useForkUpdates } from "@/hooks/fork/use-fork-updates";
import {
  WHATS_NEW_EVENT,
  currentRelease,
  newerReleases,
  readLastSeen,
  unseenReleases,
  writeLastSeen,
  type ForkRelease,
  type ForkUpdateState,
  type ReleaseNotesMode,
} from "@/lib/fork/updates";

// react-markdown loads only when a dialog opens, off the eager chunk.
const ReleaseNotesDialog = lazy(
  () => import("@/components/fork/updates/ReleaseNotesDialog"),
);

type UpdateNoticesProps = {
  variant: ForkNavVariant;
  large?: boolean | undefined;
};

/**
 * The update button (admins, when the fork has newer releases) and What's new
 * (everyone, once for each release this browser has not seen yet). Mounted
 * from ForkNavItems, which renders once: Sidebar on desktop, Bottombar on
 * mobile.
 */
export default function UpdateNotices({ variant, large }: UpdateNoticesProps) {
  const { t } = useTranslation(["fork"]);
  const isAdmin = useIsAdmin();
  const { data: state, mutate } = useForkUpdates();
  const [mode, setMode] = useState<ReleaseNotesMode | null>(null);
  const [whatsNew, setWhatsNew] = useState<ForkRelease[]>([]);

  const newer = useMemo(() => newerReleases(state), [state]);
  const currentTag = state?.current_tag ?? null;

  // The server moved to a release this browser has not shown yet.
  useEffect(() => {
    if (!state || !currentTag) {
      return;
    }
    const unseen = unseenReleases(state, readLastSeen());
    if (unseen.length > 0) {
      setWhatsNew(unseen);
      setMode((open) => open ?? "whatsNew");
    } else {
      writeLastSeen(currentTag);
    }
  }, [state, currentTag]);

  // The command palette reopens What's new on demand.
  useEffect(() => {
    const open = () => {
      const current = currentRelease(state);
      setWhatsNew(current ? [current] : (state?.releases.slice(0, 1) ?? []));
      setMode("whatsNew");
    };
    window.addEventListener(WHATS_NEW_EVENT, open);
    return () => window.removeEventListener(WHATS_NEW_EVENT, open);
  }, [state]);

  const close = useCallback(() => {
    if (mode === "whatsNew" && currentTag) {
      writeLastSeen(currentTag);
    }
    setMode(null);
  }, [mode, currentTag]);

  const checkNow = useCallback(async () => {
    try {
      const response = await axios.get<ForkUpdateState>("fork/updates", {
        params: { refresh: true },
      });
      await mutate(response.data, { revalidate: false });
    } catch {
      toast.error(t("updates.checkFailed"), { position: "top-center" });
    }
  }, [mutate, t]);

  return (
    <>
      {isAdmin && newer.length > 0 && (
        <ForkNavButton
          variant={variant}
          large={large}
          label={t("updates.button", { count: newer.length })}
          onClick={() => setMode("update")}
          data-testid="fork-update-button"
        >
          <LuRocket className={forkNavIconClass(large)} />
          <span
            data-testid="fork-update-count"
            className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-selected px-1 text-[10px] font-bold leading-none text-white"
          >
            {newer.length}
          </span>
        </ForkNavButton>
      )}
      {mode && (
        <Suspense fallback={null}>
          <ReleaseNotesDialog
            mode={mode}
            state={state}
            releases={mode === "update" ? newer : whatsNew}
            onClose={close}
            onCheckNow={isAdmin ? checkNow : undefined}
          />
        </Suspense>
      )}
    </>
  );
}
