import { useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useOverlayState } from "@/hooks/use-overlay-state";

/** Give a detail viewer one history entry; previous/next reuse that entry. */
export function useHistorySelection(key: string) {
  const [selected, setSelected] = useOverlayState<string | undefined>(key);
  const navigate = useNavigate();
  const current = useRef(selected);
  current.current = selected;
  const set = useCallback(
    (value: string | undefined) => {
      if (value === undefined && current.current !== undefined) {
        void navigate(-1);
      } else {
        setSelected(value, current.current !== undefined);
      }
    },
    [navigate, setSelected],
  );
  return [selected, set] as const;
}
