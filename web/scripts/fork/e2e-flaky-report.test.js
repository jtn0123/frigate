import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  annotation,
  flakyTests,
  readReports,
  run,
} from "./e2e-flaky-report.mjs";

const dirs = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function reportDir(files) {
  const dir = await mkdtemp(join(tmpdir(), "flaky-report-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), JSON.stringify(body));
  }
  return dir;
}

/** A report shaped like Playwright's, with one test of each status. */
function report(rootDir = "/repo/web/e2e") {
  return {
    config: { rootDir },
    suites: [
      {
        title: "specs/live.spec.ts",
        file: "specs/live.spec.ts",
        suites: [
          {
            title: "Live",
            file: "specs/live.spec.ts",
            specs: [
              {
                title: "empty group shows fallback content",
                file: "specs/live.spec.ts",
                line: 51,
                tests: [
                  {
                    status: "flaky",
                    projectName: "desktop",
                    results: [
                      {
                        status: "failed",
                        error: {
                          message:
                            "[31mError[39m: element(s) not found\nat live.spec.ts:53",
                        },
                      },
                      { status: "passed" },
                    ],
                  },
                ],
              },
              {
                title: "camera cards render",
                file: "specs/live.spec.ts",
                line: 20,
                tests: [{ status: "expected", projectName: "desktop" }],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("flakyTests", () => {
  it("reports only the flaky test, with its describe path and cause", () => {
    const found = flakyTests(report(), "/repo");

    expect(found).toEqual([
      {
        file: "web/e2e/specs/live.spec.ts",
        line: 51,
        title: "Live > empty group shows fallback content",
        project: "desktop",
        attempts: 2,
        error: "Error: element(s) not found",
      },
    ]);
  });

  it("is empty for a report without flaky tests", () => {
    const clean = report();
    clean.suites[0].suites[0].specs[0].tests[0].status = "unexpected";

    expect(flakyTests(clean, "/repo")).toEqual([]);
  });

  it("tolerates a report with no suites", () => {
    expect(flakyTests({}, "/repo")).toEqual([]);
  });
});

describe("annotation", () => {
  it("annotates a warning that names the file, line and project", () => {
    const [test] = flakyTests(report(), "/repo");

    expect(annotation(test, false)).toBe(
      "::warning file=web/e2e/specs/live.spec.ts,line=51,title=Flaky e2e " +
        "test::Flaky e2e test [desktop]: Live > empty group shows fallback " +
        "content, passed on attempt 2: Error: element(s) not found",
    );
  });

  it("annotates an error when strict and escapes the message", () => {
    const [test] = flakyTests(report(), "/repo");
    test.error = "100% of\nattempts";

    const line = annotation(test, true);

    expect(line.startsWith("::error ")).toBe(true);
    expect(line).toContain("100%25 of%0Aattempts");
  });
});

describe("readReports", () => {
  it("reads every results*.json and nothing else", async () => {
    const dir = await reportDir({
      "results.json": report(),
      "results-csp.json": report(),
      "trace.json": { suites: [] },
    });

    expect(readReports(dir).map((entry) => entry.name)).toEqual([
      "results-csp.json",
      "results.json",
    ]);
  });

  it("orders report names consistently even when directory enumeration differs", async () => {
    const dir = await reportDir({
      "results-z.json": report(),
      "results-10.json": report(),
      "results-2.json": report(),
    });

    expect(readReports(dir).map((entry) => entry.name)).toEqual([
      "results-10.json",
      "results-2.json",
      "results-z.json",
    ]);
  });
});

describe("run", () => {
  it("passes and says so when nothing was flaky", async () => {
    const clean = report();
    clean.suites[0].suites[0].specs[0].tests[0].status = "expected";
    const dir = await reportDir({ "results.json": clean });
    const lines = [];

    const code = run(dir, { repoRoot: "/repo", log: (l) => lines.push(l) });

    expect(code).toBe(0);
    expect(lines).toEqual(["No flaky e2e tests in 1 report(s)"]);
  });

  it("annotates without failing when flaky tests are only reported", async () => {
    const dir = await reportDir({
      "results.json": report(),
      "results-csp.json": report(),
    });
    const lines = [];

    const code = run(dir, { repoRoot: "/repo", log: (l) => lines.push(l) });

    expect(code).toBe(0);
    expect(lines.filter((l) => l.startsWith("::warning "))).toHaveLength(2);
    expect(lines.at(-1)).toContain("2 flaky test(s) in 2 report(s)");
  });

  it("fails when strict", async () => {
    const dir = await reportDir({ "results.json": report() });
    const lines = [];

    const code = run(dir, {
      strict: true,
      repoRoot: "/repo",
      log: (l) => lines.push(l),
    });

    expect(code).toBe(1);
    expect(lines.at(-1)).toContain("1 flaky test(s) in 1 report(s)");
  });

  it("fails when the json reporter wrote nothing", async () => {
    const dir = await reportDir({ "trace.json": { suites: [] } });
    const lines = [];

    const code = run(dir, { repoRoot: "/repo", log: (l) => lines.push(l) });

    expect(code).toBe(1);
    expect(lines[0]).toContain("No Playwright JSON report");
  });

  it("fails when the directory does not exist", () => {
    const lines = [];

    const code = run(join(tmpdir(), "flaky-report-missing"), {
      repoRoot: "/repo",
      log: (l) => lines.push(l),
    });

    expect(code).toBe(1);
    expect(lines[0]).toContain("No Playwright JSON report");
  });
});
