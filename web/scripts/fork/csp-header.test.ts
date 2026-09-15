/** The e2e CSP check must read the policy that ships, and notice if it stops enforcing. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  SECURITY_HEADERS_CONF,
  cspHeaders,
  policyFrom,
} from "./csp-header.mjs";

const ENFORCING =
  "add_header Content-Security-Policy \"default-src 'self'\" always;";
const REPORT_ONLY =
  "add_header Content-Security-Policy-Report-Only \"default-src 'self'\" always;";

describe("csp-header", () => {
  it("reads the enforcing policy", () => {
    expect(policyFrom(ENFORCING)).toBe("default-src 'self'");
  });

  it("rejects a report-only policy", () => {
    expect(() => policyFrom(REPORT_ONLY)).toThrow(/No enforcing/);
  });

  it("serves no header unless E2E_CSP is set", () => {
    expect(cspHeaders({})).toEqual({});
  });

  it("serves the policy when E2E_CSP is set", () => {
    const headers = cspHeaders({ E2E_CSP: "1" });
    expect(headers["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(headers["Content-Security-Policy"]).toContain("object-src 'none'");
  });

  it("the shipped nginx config is still enforcing", () => {
    const conf = readFileSync(SECURITY_HEADERS_CONF, "utf8");
    expect(conf).not.toMatch(/add_header Content-Security-Policy-Report-Only/);
    expect(policyFrom(conf)).toContain("frame-src 'self'");
  });
});
