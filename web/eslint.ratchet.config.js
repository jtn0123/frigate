/**
 * Type-aware rule counting for web/scripts/fork/type-ratchet.mjs.
 * Warn-only on all of src so npm run lint stays fork-scoped.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

const typeAwareRules = {
  "@typescript-eslint/no-floating-promises": "warn",
  "@typescript-eslint/no-misused-promises": "warn",
  "@typescript-eslint/no-unnecessary-condition": "warn",
  "@typescript-eslint/no-unsafe-member-access": "warn",
  "@typescript-eslint/no-unsafe-assignment": "warn",
  "@typescript-eslint/no-unsafe-return": "warn",
  "@typescript-eslint/no-unsafe-argument": "warn",
  "@typescript-eslint/no-unsafe-call": "warn",
  "@typescript-eslint/switch-exhaustiveness-check": "warn",
};

export default tseslint.config({
  files: ["src/**/*.{ts,tsx}"],
  ignores: ["**/*.d.ts"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: true,
      tsconfigRootDir,
    },
  },
  plugins: {
    "@typescript-eslint": tseslint.plugin,
  },
  rules: typeAwareRules,
});
