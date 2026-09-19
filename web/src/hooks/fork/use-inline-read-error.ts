/**
 * Fork (UI103): a page that draws its own error state for an SWR read claims
 * that read while mounted, so the global read-error toast stays quiet.
 */

import { useEffect } from "react";
import { claimReadErrors } from "@/api/fork/read-error-toast";

export function useInlineReadError(key: string): void {
  useEffect(() => claimReadErrors(key), [key]);
}
