/** Normalize saved and pending go2rtc streams for preview and Save All. */
export function compareGo2RtcStreams(
  saved: Record<string, string | string[]> | undefined,
  live: Record<string, string[]>,
) {
  const savedLists: Record<string, string[]> = {};
  for (const [name, urls] of Object.entries(saved ?? {})) {
    savedLists[name] = Array.isArray(urls) ? urls : [urls];
  }

  return {
    savedLists,
    deletedNames: Object.keys(savedLists).filter((name) => !(name in live)),
  };
}
