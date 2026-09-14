import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/** Keep shareable view selections in the URL, including browser history. */
export function useViewQuery() {
  const location = useLocation();
  const navigate = useNavigate();
  const update = useCallback(
    (values: Record<string, string | null>) => {
      const params = new URLSearchParams(location.search);
      for (const [key, value] of Object.entries(values)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      const search = params.toString();
      if (search === location.search.replace(/^\?/, "")) return;
      const state: unknown = location.state;
      void navigate(
        { pathname: location.pathname, search, hash: location.hash },
        { state },
      );
    },
    [location, navigate],
  );
  return [new URLSearchParams(location.search), update] as const;
}
