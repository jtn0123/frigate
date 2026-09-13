/**
 * Fork (UI52): whether shortcut hints should use Apple modifier names.
 *
 * The command palette opens with Cmd+K or Ctrl+K everywhere, but its hint
 * said "Ctrl+K" on Macs too.
 */

type PlatformSource = { platform?: string; userAgent?: string };

export function isApplePlatform(nav: PlatformSource = navigator): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(nav.platform || nav.userAgent || "");
}
