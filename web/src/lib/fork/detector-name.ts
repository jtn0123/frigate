/**
 * Fork (UI52): display name for a detector key in status messages.
 *
 * Detector keys are user-chosen config keys. Upstream capitalized only the
 * first letter, so the common `cpu` detector read "Cpu is slow". Hardware
 * acronyms are upper-cased; anything else keeps the old behavior.
 */

const ACRONYMS = new Set(["cpu", "gpu", "npu", "tpu"]);

export function formatDetectorName(key: string): string {
  let first = true;
  return key.replace(/[a-z0-9]+/gi, (word) => {
    const isFirst = first;
    first = false;
    if (ACRONYMS.has(word.toLowerCase())) {
      return word.toUpperCase();
    }
    return isFirst ? word.charAt(0).toUpperCase() + word.slice(1) : word;
  });
}
