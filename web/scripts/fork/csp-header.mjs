/**
 * The Content-Security-Policy nginx serves, read from its own config.
 *
 * `vite preview` serves it when E2E_CSP is set so the e2e suite loads the built
 * app behind the same policy that ships, and cannot drift from it (E6).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SECURITY_HEADERS_CONF = resolve(
  here,
  "../../../docker/main/rootfs/usr/local/nginx/conf/security_headers.conf",
);

/** The enforcing policy in a security_headers.conf, or an error if it is report-only. */
export function policyFrom(conf) {
  const match = /add_header Content-Security-Policy "([^"]+)"/.exec(conf);
  if (!match) {
    throw new Error(
      "No enforcing Content-Security-Policy in security_headers.conf",
    );
  }
  return match[1];
}

/** Headers for `vite preview`: the policy when E2E_CSP is set, nothing otherwise. */
export function cspHeaders(
  env = process.env,
  confPath = SECURITY_HEADERS_CONF,
) {
  if (!env["E2E_CSP"]) {
    return {};
  }
  return {
    "Content-Security-Policy": policyFrom(readFileSync(confPath, "utf8")),
  };
}
