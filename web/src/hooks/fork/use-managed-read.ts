import { useEffect, useRef } from "react";
import useSWR, {
  SWRConfiguration,
  unstable_serialize,
  useSWRConfig,
} from "swr";
import axios from "axios";
import { managedReadsFor, ManagedKey } from "@/api/fork/managed-reads";

/** Cancel abandoned page reads without cancelling another mounted consumer. */
export function useManagedRead<T>(
  key: ManagedKey,
  options?: SWRConfiguration<T, Error>,
) {
  const { cache } = useSWRConfig();
  const pool = managedReadsFor(cache);
  const id = unstable_serialize(key);
  const keyRef = useRef({ id, key });
  if (keyRef.current.id !== id) keyRef.current = { id, key };
  const stableKey = keyRef.current.key;
  useEffect(() => pool.retain(stableKey), [pool, stableKey]);
  return useSWR<T, Error>(
    stableKey,
    (requestKey: ManagedKey) => pool.read<T>(requestKey),
    {
      keepPreviousData: false,
      shouldRetryOnError: (error) => !axios.isCancel(error),
      ...(pool.isWarm(stableKey) && cache.get(id)?.data !== undefined
        ? { revalidateOnMount: false }
        : {}),
      ...options,
    },
  );
}
