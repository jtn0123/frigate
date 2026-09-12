/** Self-tests verify both the injected error and the collector's response. */
import { test, expect } from "../../fixtures/frigate-test";

test.describe("Error Collector - clean @meta", () => {
  test("clean page passes", async ({ frigateApp, errorCollector }) => {
    await frigateApp.goto("/");
    expect(errorCollector.errors).toEqual([]);
    expect(() => errorCollector.assertClean()).not.toThrow();
  });
});

test.describe("Error Collector - unallowlisted console error fails @meta", () => {
  test("console.error fails the test when not allowlisted", async ({
    page,
    frigateApp,
    errorCollector,
  }) => {
    test.skip(
      process.env.E2E_STRICT_ERRORS !== "1",
      "Requires E2E_STRICT_ERRORS=1 to assert failure",
    );
    test.fail(); // Fixture teardown must reject the captured error.
    await frigateApp.goto("/");
    const observed = page.waitForEvent(
      "console",
      (message) => message.text() === "UNEXPECTED_DELIBERATE_TEST_ERROR_xyz123",
    );
    await page.evaluate(() => {
      // eslint-disable-next-line no-console
      console.error("UNEXPECTED_DELIBERATE_TEST_ERROR_xyz123");
    });
    await observed;
    expect(errorCollector.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "console",
          message: "UNEXPECTED_DELIBERATE_TEST_ERROR_xyz123",
        }),
      ]),
    );
  });
});

test.describe("Error Collector - allowlisted console error passes @meta", () => {
  test.use({ expectedErrors: [/ALLOWED_DELIBERATE_TEST_ERROR_xyz123/] });
  test("console.error is silenced when allowlisted via expectedErrors", async ({
    page,
    frigateApp,
    errorCollector,
  }) => {
    await frigateApp.goto("/");
    const observed = page.waitForEvent(
      "console",
      (message) => message.text() === "ALLOWED_DELIBERATE_TEST_ERROR_xyz123",
    );
    await page.evaluate(() => {
      // eslint-disable-next-line no-console
      console.error("ALLOWED_DELIBERATE_TEST_ERROR_xyz123");
    });
    expect((await observed).type()).toBe("error");
    expect(errorCollector.errors).toEqual([]);
    expect(() => errorCollector.assertClean()).not.toThrow();
  });
});

test.describe("Error Collector - uncaught pageerror fails @meta", () => {
  test("uncaught pageerror fails the test", async ({
    page,
    frigateApp,
    errorCollector,
  }) => {
    test.skip(
      process.env.E2E_STRICT_ERRORS !== "1",
      "Requires E2E_STRICT_ERRORS=1 to assert failure",
    );
    test.fail();
    await frigateApp.goto("/");
    const observed = page.waitForEvent("pageerror");
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error("UNCAUGHT_DELIBERATE_TEST_ERROR_xyz789");
      }, 0);
    });
    expect((await observed).message).toBe(
      "UNCAUGHT_DELIBERATE_TEST_ERROR_xyz789",
    );
    expect(errorCollector.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "pageerror",
          message: "UNCAUGHT_DELIBERATE_TEST_ERROR_xyz789",
        }),
      ]),
    );
  });
});

test.describe("Error Collector - 5xx fails @meta", () => {
  test("same-origin 5xx response fails the test", async ({
    page,
    frigateApp,
    errorCollector,
  }) => {
    test.skip(
      process.env.E2E_STRICT_ERRORS !== "1",
      "Requires E2E_STRICT_ERRORS=1 to assert failure",
    );
    test.fail();
    await page.route("**/api/version", (route) =>
      route.fulfill({ status: 500, body: "boom" }),
    );
    await frigateApp.goto("/");
    const status = await page.evaluate(
      async () => (await fetch("/api/version")).status,
    );
    expect(status).toBe(500);
    expect(errorCollector.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "request",
          message: expect.stringContaining("500"),
        }),
      ]),
    );
  });
});

test.describe("Error Collector - allowlisted 5xx passes @meta", () => {
  // A single regex avoids Playwright interpreting two array entries as a fixture tuple.
  test.use({
    expectedErrors: [/500.*\/api\/version|Failed to load resource.*500/],
  });
  test("allowlisted 5xx passes", async ({
    page,
    frigateApp,
    errorCollector,
  }) => {
    await page.route("**/api/version", (route) =>
      route.fulfill({ status: 500, body: "boom" }),
    );
    await frigateApp.goto("/");
    const status = await page.evaluate(
      async () => (await fetch("/api/version")).status,
    );
    expect(status).toBe(500);
    expect(errorCollector.errors).toEqual([]);
    expect(() => errorCollector.assertClean()).not.toThrow();
  });
});
