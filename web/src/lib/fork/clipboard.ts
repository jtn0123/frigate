import copy from "copy-to-clipboard";

/**
 * Copy text, then run `onCopied` or `onRefused` by whether the browser
 * allowed it. copy-to-clipboard 4 resolves to that result instead of
 * returning it, and no longer falls back to a prompt (F18), so a success
 * message has to wait for it.
 */
export async function copyThen(
  text: string,
  onCopied: () => void,
  onRefused?: () => void,
): Promise<void> {
  if (await copy(text)) {
    onCopied();
  } else {
    onRefused?.();
  }
}
