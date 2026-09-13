import { useCallback, useEffect } from "react";
import { useBeforeUnload, useBlocker } from "react-router-dom";
import { useTranslation } from "react-i18next";

/** Protect unsaved edits when leaving the editor or closing the browser tab. */
export function useUnsavedNavigation(dirty: boolean) {
  const { t } = useTranslation("fork");
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useBeforeUnload(
    useCallback(
      (event: BeforeUnloadEvent) => {
        if (!dirty) return;
        event.preventDefault();
        event.returnValue = "";
      },
      [dirty],
    ),
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (!dirty || window.confirm(t("navigation.unsaved"))) blocker.proceed();
    else blocker.reset();
  }, [blocker, dirty, t]);
}
