/// <reference types="vitest/config" />
import path, { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import monacoEditorPlugin from "vite-plugin-monaco-editor";
// @ts-expect-error -- plain ESM helper shared with the e2e CSP check (E6)
import { cspHeaders } from "./scripts/fork/csp-header.mjs";
import { vendorChunkGroups } from "./scripts/fork/vendor-chunks.mjs";

const proxyHost = process.env.PROXY_HOST || "localhost:5000";

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    "import.meta.vitest": "undefined",
  },
  preview: {
    headers: cspHeaders(),
  },
  server: {
    proxy: {
      "/api": {
        target: `http://${proxyHost}`,
        ws: true,
      },
      "/vod": {
        target: `http://${proxyHost}`,
      },
      "/clips": {
        target: `http://${proxyHost}`,
      },
      "/exports": {
        target: `http://${proxyHost}`,
      },
      "/ws": {
        target: `ws://${proxyHost}`,
        ws: true,
      },
      "/live": {
        target: `ws://${proxyHost}`,
        ws: true,
      },
    },
  },
  build: {
    sourcemap: process.env.E2E_COVERAGE === "1",
    // Only the monaco editor chunk legitimately exceeds this.
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        login: resolve(import.meta.dirname, "login.html"),
      },
      output: {
        keepNames: true,
        // Named vendor chunks in priority order (F18, see the helper).
        codeSplitting: {
          groups: vendorChunkGroups(),
        },
      },
    },
  },
  plugins: [
    react(),
    monacoEditorPlugin.default({
      customWorkers: [{ label: "yaml", entry: "monaco-yaml/yaml.worker" }],
      languageWorkers: ["editorWorkerService"], // we don't use any of the default languages
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      // second module id for the full lucide set, see src/components/icons/luIcons.ts
      "react-icons-lu-all": path.resolve(
        import.meta.dirname,
        "node_modules/react-icons/lu/index.js",
      ),
    },
  },
  test: {
    environment: "jsdom",
    alias: [
      // Monaco has only an ESM entry; preserve its deep import paths.
      {
        find: /^monaco-editor$/,
        replacement: path.resolve(
          import.meta.dirname,
          "node_modules/monaco-editor/esm/vs/editor/editor.main.js",
        ),
      },
      {
        find: "testing-library",
        replacement: path.resolve(
          import.meta.dirname,
          "./__test__/testing-library.js",
        ),
      },
    ],
    setupFiles: ["./__test__/test-setup.ts"],
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "__test__/**/*.{test,spec}.{ts,tsx}",
      "scripts/fork/**/*.test.{ts,js}",
    ],
    exclude: ["node_modules/**", "dist/**", "e2e/**"],
    includeSource: ["src/**/*.{js,jsx,ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov", "json"],
      // D48: exact bf2c15c release measured 41.91% Vitest-only lines.
      // Keep one point of drift, plus the stronger fork-library floors.
      thresholds: {
        lines: 40.91,
        "src/lib/fork/**": { lines: 87.5 },
        "src/hooks/fork/**": { lines: 57 },
      },
      include: ["src/**/*.{ts,tsx}", "scripts/fork/**/*.mjs"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.d.ts",
        "src/types/**",
        "src/components/ui/**",
      ],
    },
    mockReset: true,
    restoreMocks: true,
    globals: true,
  },
});
