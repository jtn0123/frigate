/**
 * Fork: the Content-Security-Policy nginx serves is enforced (E6).
 *
 * Run with E2E_CSP=1 so `vite preview` serves the same policy string nginx
 * does (vite.config.ts reads it from security_headers.conf). Without the
 * variable the header is absent and these tests skip, so the ordinary e2e run
 * is unchanged. CI runs one pass with it set.
 *
 *   E2E_CSP=1 npx playwright test -c e2e/playwright.config.ts specs/fork/csp
 */

import { test, expect } from "../../fixtures/frigate-test";
import type { Page } from "@playwright/test";

/** Pages that load the heaviest machinery: workers, players and canvases. */
const ROUTES = ["/", "/review", "/explore", "/export", "/settings", "/system"];

type Violation = { directive: string; blocked: string };

async function collectViolations(page: Page): Promise<Violation[]> {
  const violations: Violation[] = [];
  await page.exposeFunction("__forkCspViolation", (violation: Violation) => {
    violations.push(violation);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const report = event as SecurityPolicyViolationEvent;
      (
        window as unknown as {
          __forkCspViolation?: (v: {
            directive: string;
            blocked: string;
          }) => void;
        }
      ).__forkCspViolation?.({
        directive: report.effectiveDirective || report.violatedDirective,
        blocked: report.blockedURI,
      });
    });
  });
  return violations;
}

test.describe("Content-Security-Policy @high", () => {
  test.skip(
    !process.env["E2E_CSP"],
    "run with E2E_CSP=1 so the preview server serves the policy",
  );

  test("the served policy is enforcing, not report-only", async ({
    frigateApp,
  }) => {
    const response = await frigateApp.page.goto("/");
    const headers = response?.headers() ?? {};
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["content-security-policy-report-only"]).toBeUndefined();
  });

  test("no page violates the policy, on either layout @mobile", async ({
    frigateApp,
  }) => {
    const violations = await collectViolations(frigateApp.page);
    for (const route of ROUTES) {
      await frigateApp.goto(route);
      // Lazily imported chunks, workers and players start after first paint;
      // the network settling is the signal that they have.
      await frigateApp.page.waitForLoadState("networkidle");
      await expect(violations).toEqual([]);
    }
  });
});
