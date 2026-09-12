import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * D9: fixtures must match the OpenAPI 200 schemas before any spec runs.
 * The e2e bundle is built by `make check` / CI, not here.
 */
export default function globalSetup() {
  const webDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  execSync("node e2e/scripts/validate-fixtures.mjs", {
    cwd: webDir,
    stdio: "inherit",
  });
}
