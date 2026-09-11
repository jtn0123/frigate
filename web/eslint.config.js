// ESLint 9 flat config. Replaces .eslintrc.cjs and keeps its intent:
//   - react-hooks rules and no-console are errors
//   - unused vars/args/caught errors are allowed when prefixed with "_"
//   - prettier disagreements are errors (they were warnings before)
//   - dist, *.d.ts and the vendored src/components/ui are not linted
// jsx-a11y is new here and reports warnings only while the callsites are
// brought into line.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import jsxA11y from "eslint-plugin-jsx-a11y";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import globals from "globals";

const unusedVarsOptions = {
  argsIgnorePattern: "^_",
  varsIgnorePattern: "^_",
  // typescript-eslint 8 checks caught errors by default; v7 did not, and the
  // tree has many `catch (error)` blocks that ignore the value on purpose.
  caughtErrors: "none",
  caughtErrorsIgnorePattern: "^_",
};

// Every jsx-a11y recommended rule, downgraded to a warning.
const jsxA11yWarnings = Object.fromEntries(
  Object.entries(jsxA11y.flatConfigs.recommended.rules).map(([name, level]) => [
    name,
    Array.isArray(level) ? ["warn", ...level.slice(1)] : "warn",
  ]),
);

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "coverage/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "**/*.d.ts",
      "src/components/ui/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierRecommended,
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser, ...globals.es2021 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "jsx-a11y": jsxA11y,
    },
    rules: {
      ...jsxA11yWarnings,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // Declared after the prettier config so it stays enabled; every kind is
      // "always-multiline" to match prettier's trailingComma: "all".
      "comma-dangle": [
        "error",
        {
          arrays: "always-multiline",
          objects: "always-multiline",
          imports: "always-multiline",
          exports: "always-multiline",
          functions: "always-multiline",
        },
      ],
      // The core rule only applies to plain JS; TypeScript files use the
      // typescript-eslint version so type-only usage is understood.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", unusedVarsOptions],
      // `cond && fn()` short-circuit calls are used throughout the tree.
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowShortCircuit: true, allowTernary: true },
      ],
      // `interface Props extends BaseProps {}` is the shadcn/radix convention.
      "@typescript-eslint/no-empty-object-type": [
        "error",
        { allowInterfaces: "with-single-extends" },
      ],
      "no-console": "error",
      "prettier/prettier": [
        "error",
        { plugins: ["prettier-plugin-tailwindcss"] },
      ],
    },
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    rules: {
      "no-unused-vars": ["error", unusedVarsOptions],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Tooling that runs under node rather than in the browser.
    files: [
      "*.{js,cjs,mjs,ts}",
      "e2e/**/*.{js,mjs,ts}",
      "__test__/**/*.{js,ts}",
      "scripts/**/*.{js,mjs,ts}",
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // CommonJS config files and CLI scripts.
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["e2e/scripts/**", "scripts/**"],
    rules: { "no-console": "off" },
  },
  {
    files: ["**/*.test.{ts,tsx}", "__test__/**/*.{js,ts}"],
    languageOptions: {
      globals: { ...globals.vitest },
    },
  },
  {
    // C11: rejected promises and async onClick handlers were silent
    // ("the button did nothing"). Fork paths already get these from C10
    // once that PR merges; keeping them here covers all of src.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["**/*.d.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
);
