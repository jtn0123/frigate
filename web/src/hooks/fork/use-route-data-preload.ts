import { useSWRConfig } from "swr";
import { useContext } from "react";
import { AuthContext } from "@/context/auth-state";
import { managedReadsFor } from "@/api/fork/managed-reads";
import { canPreloadRoute } from "@/utils/routePreload";

/** Warm small export metadata on explicit intent, sharing the active SWR cache. */
export function useRouteDataPreload() {
  const { cache, mutate } = useSWRConfig();
  const { auth } = useContext(AuthContext);
  const pool = managedReadsFor(cache);
  return (path: string) => {
    if (
      path !== "/export" ||
      !canPreloadRoute() ||
      auth.isLoading ||
      (auth.isAuthenticated && !auth.user)
    )
      return;
    for (const key of ["cases"]) {
      if (pool.isWarm(key)) continue;
      pool.warm(key);
      const release = pool.retain(key);
      void mutate(key, pool.read(key), { revalidate: false })
        .catch(() => {
          pool.forgetWarm(key);
        })
        .finally(release);
    }
  };
}
