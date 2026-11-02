/**
 * The named vendor chunks of the production build, as Rolldown code
 * splitting groups (F18).
 *
 * Named chunks keep a release that only touches app code from invalidating
 * the cached framework and library bundles. A Rolldown group also captures
 * what its modules import, so the groups go in priority order: react is
 * claimed before the chart, motion and canvas groups could take it along,
 * and the preload helper before the editor group could, which would make
 * those lazy chunks eager.
 */

/** The npm package a module id belongs to, or undefined for app code. */
export function packageName(id) {
  if (!id.includes("node_modules/")) {
    return undefined;
  }
  const pkg = id.split("node_modules/").pop().split("/");
  return pkg[0].startsWith("@") ? `${pkg[0]}/${pkg[1]}` : pkg[0];
}

function inPackages(...names) {
  return (id) => names.includes(packageName(id));
}

function packagePrefix(prefix) {
  return (id) => packageName(id)?.startsWith(prefix) ?? false;
}

/** Chunk name and module test, highest priority first. */
export const VENDOR_CHUNKS = [
  [
    "vendor-react",
    (id) =>
      id.includes("vite/preload-helper") ||
      inPackages(
        "react",
        "react-dom",
        "react-router",
        "react-router-dom",
        "@remix-run/router",
        "scheduler",
      )(id),
  ],
  ["vendor-radix", packagePrefix("@radix-ui/")],
  ["vendor-charts", inPackages("apexcharts", "react-apexcharts")],
  ["vendor-monaco", inPackages("monaco-editor", "monaco-yaml")],
  ["vendor-hls", inPackages("hls.js")],
  ["vendor-konva", inPackages("konva", "react-konva")],
  ["vendor-motion", inPackages("framer-motion", "motion-dom", "motion-utils")],
  [
    "vendor-i18n",
    (id) => packagePrefix("i18next")(id) || inPackages("react-i18next")(id),
  ],
];

/** The `codeSplitting.groups` for `build.rolldownOptions.output`. */
export function vendorChunkGroups() {
  return VENDOR_CHUNKS.map(([name, test], index) => ({
    name,
    test,
    priority: VENDOR_CHUNKS.length - index,
  }));
}
