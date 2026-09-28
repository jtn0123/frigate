/**
 * Namespaces that ship in English only. Every other language loads them from
 * `en`, which is what the `en` fallback would show anyway, instead of asking
 * for a file that does not exist and logging a 404 on every page load.
 */
export const ENGLISH_ONLY_NAMESPACES: ReadonlySet<string> = new Set(["fork"]);

/**
 * Build the i18next-http-backend `loadPath` for one namespace request.
 *
 * The backend requests one language and namespace at a time (multi-loading is
 * off), so only the first namespace decides the language folder.
 */
export function localeLoadPath(
  baseUrl: string,
  version: string,
): (lngs: string[], namespaces: string[]) => string {
  return (_lngs, [namespace]) => {
    const englishOnly =
      namespace !== undefined && ENGLISH_ONLY_NAMESPACES.has(namespace);
    const lng = englishOnly ? "en" : "{{lng}}";
    return `${baseUrl}locales/${lng}/{{ns}}.json?v=${version}`;
  };
}
