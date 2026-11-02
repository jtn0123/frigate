import { describe, expect, it } from "vitest";
import {
  packageName,
  vendorChunkGroups,
  VENDOR_CHUNKS,
} from "./vendor-chunks.mjs";

/** The chunk Rolldown picks for a module: the highest priority match. */
function chunkFor(id) {
  const matches = vendorChunkGroups()
    .filter((group) => group.test(id))
    .sort((a, b) => b.priority - a.priority);
  return matches[0]?.name;
}

const nm = (path) => `/work/web/node_modules/${path}`;

describe("packageName", () => {
  it("reads plain and scoped packages, and nothing for app code", () => {
    expect(packageName(nm("react/index.js"))).toBe("react");
    expect(packageName(nm("@radix-ui/react-dialog/dist/index.mjs"))).toBe(
      "@radix-ui/react-dialog",
    );
    expect(packageName(nm("a/node_modules/hls.js/dist/hls.mjs"))).toBe(
      "hls.js",
    );
    expect(packageName("/work/web/src/main.tsx")).toBeUndefined();
  });
});

describe("vendor chunk groups", () => {
  it("names each vendor chunk once, in descending priority", () => {
    const groups = vendorChunkGroups();
    expect(groups.map((group) => group.name)).toEqual(
      VENDOR_CHUNKS.map(([name]) => name),
    );
    expect(new Set(groups.map((group) => group.name)).size).toBe(groups.length);
    const priorities = groups.map((group) => group.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
    expect(Math.min(...priorities)).toBeGreaterThan(0);
  });

  it.each([
    [nm("react/jsx-runtime.js"), "vendor-react"],
    [nm("scheduler/index.js"), "vendor-react"],
    ["\0vite/preload-helper.js", "vendor-react"],
    [nm("@radix-ui/react-popover/dist/index.mjs"), "vendor-radix"],
    [nm("apexcharts/dist/apexcharts.esm.js"), "vendor-charts"],
    [nm("react-apexcharts/dist/index.js"), "vendor-charts"],
    [nm("monaco-yaml/index.js"), "vendor-monaco"],
    [nm("hls.js/dist/hls.mjs"), "vendor-hls"],
    [nm("react-konva/es/ReactKonva.js"), "vendor-konva"],
    [nm("motion-dom/dist/index.mjs"), "vendor-motion"],
    [nm("i18next-http-backend/esm/index.js"), "vendor-i18n"],
    [nm("react-i18next/dist/es/index.js"), "vendor-i18n"],
  ])("puts %s in %s", (id, chunk) => {
    expect(chunkFor(id)).toBe(chunk);
  });

  it("leaves app code and other packages to automatic chunking", () => {
    expect(chunkFor("/work/web/src/components/Statusbar.tsx")).toBeUndefined();
    expect(chunkFor(nm("lodash/lodash.js"))).toBeUndefined();
    expect(chunkFor(nm("react-icons/lu/index.mjs"))).toBeUndefined();
  });
});
