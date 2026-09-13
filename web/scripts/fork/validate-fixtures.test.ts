import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FIXTURE_MAP,
  validateFixtures,
} from "../../e2e/scripts/validate-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "../../e2e/fixtures/mock-data");

describe("validateFixtures", () => {
  it("accepts every mapped JSON fixture or skips it with a reason", () => {
    const report = validateFixtures();
    expect(report.ok).toBe(true);
    expect(report.results.map((row) => row.file).sort()).toEqual(
      Object.keys(FIXTURE_MAP).sort(),
    );
    expect(
      report.results
        .filter((row) => row.status === "skip")
        .map((row) => row.file)
        .sort(),
    ).toEqual(["config-schema.json", "review-summary.json"]);
    expect(
      report.results
        .filter((row) => row.status === "pass")
        .map((row) => row.file)
        .sort(),
    ).toEqual([
      "cases.json",
      "config-snapshot.json",
      "events.json",
      "exports.json",
      "reviews.json",
    ]);
  });

  it("fails when a required spec field is removed", () => {
    const reviews = JSON.parse(
      readFileSync(join(fixtureDir, "reviews.json"), "utf8"),
    ) as Array<Record<string, unknown>>;
    const [{ id: _id, ...broken }, ...rest] = reviews;
    void _id;
    const report = validateFixtures({
      payloads: { "reviews.json": [broken, ...rest] },
    });
    expect(report.ok).toBe(false);
    const review = report.results.find((row) => row.file === "reviews.json");
    expect(review?.status).toBe("fail");
    expect(review?.errors.join(" ")).toMatch(/id/i);
  });

  it("fails when a JSON fixture is not in FIXTURE_MAP", () => {
    const report = validateFixtures({ extraFiles: ["unmapped.json"] });
    expect(report.ok).toBe(false);
    const extra = report.results.find((row) => row.file === "unmapped.json");
    expect(extra?.status).toBe("fail");
    expect(extra?.errors.join(" ")).toMatch(/unmapped/);
  });
});
