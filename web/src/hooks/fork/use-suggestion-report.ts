import useSWR from "swr";
import { isForkEnabled } from "@/fork/flags";
import {
  reportKey,
  type SuggestionReport,
} from "@/lib/fork/classification-suggestions";

/**
 * How often the model's drafts were kept as-is (fork I42).
 *
 * Read from the provenance file on request; the confirm hook revalidates
 * it after every filing, so the number on the grid moves as you work.
 */
export function useSuggestionReport(modelName: string) {
  const key = isForkEnabled("classificationSuggestions")
    ? reportKey(modelName)
    : null;
  return useSWR<SuggestionReport>(key, { revalidateOnFocus: false });
}
