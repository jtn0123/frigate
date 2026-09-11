/// <reference types="vitest" />
import path, { resolve } from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import monacoEditorPlugin from "vite-plugin-monaco-editor";

const proxyHost = process.env.PROXY_HOST || "localhost:5000";

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    "import.meta.vitest": "undefined",
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
        changeOrigin: true,
        ws: true,
      },
    },
  },
  esbuild: {
    keepNames: true,
  },
  build: {
    // Only the monaco editor chunk legitimately exceeds this.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        login: resolve(__dirname, "login.html"),
      },
      output: {
        // Named vendor chunks so a release that touches app code does not
        // invalidate the cached framework and library bundles.
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return;
          }
          const pkg = id.split("node_modules/").pop()?.split("/") ?? [];
          const name = pkg[0]?.startsWith("@") ? `${pkg[0]}/${pkg[1]}` : pkg[0];
          if (!name) {
            return;
          }
          if (
            [
              "react",
              "react-dom",
              "react-router",
              "react-router-dom",
              "@remix-run/router",
              "scheduler",
            ].includes(name)
          ) {
            return "vendor-react";
          }
          if (name.startsWith("@radix-ui/")) {
            return "vendor-radix";
          }
          if (name === "apexcharts" || name === "react-apexcharts") {
            return "vendor-charts";
          }
          if (name === "monaco-editor" || name === "monaco-yaml") {
            return "vendor-monaco";
          }
          if (name === "hls.js") {
            return "vendor-hls";
          }
          if (name === "konva" || name === "react-konva") {
            return "vendor-konva";
          }
          if (
            name === "framer-motion" ||
            name === "motion-dom" ||
            name === "motion-utils"
          ) {
            return "vendor-motion";
          }
          if (name.startsWith("i18next") || name === "react-i18next") {
            return "vendor-i18n";
          }
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
      "@": path.resolve(__dirname, "./src"),
      // second module id for the full lucide set, see src/components/icons/luIcons.ts
      "react-icons-lu-all": path.resolve(
        __dirname,
        "node_modules/react-icons/lu/index.js",
      ),
    },
  },
  test: {
    environment: "jsdom",
    alias: {
      "testing-library": path.resolve(
        __dirname,
        "./__test__/testing-library.js",
      ),
    },
    setupFiles: ["./__test__/test-setup.ts"],
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "__test__/**/*.{test,spec}.{ts,tsx}",
      "scripts/fork/**/*.test.ts",
    ],
    exclude: ["node_modules/**", "dist/**", "e2e/**"],
    includeSource: ["src/**/*.{js,jsx,ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
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
