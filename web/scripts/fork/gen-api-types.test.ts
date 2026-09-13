import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { outPath, renderTypes, run } from "./gen-api-types.mjs";

const scratch = () =>
  join(mkdtempSync(join(tmpdir(), "api-gen-")), "api.gen.ts");

describe("gen-api-types", () => {
  it("renders the spec with the regenerate banner", async () => {
    const rendered = await renderTypes();

    expect(rendered).toContain("// Source: docs/static/frigate-api.yaml");
    expect(rendered).toContain("ReviewSegmentResponse");
    expect(rendered).toBe(readFileSync(outPath, "utf8"));
  });

  it("passes --check when the committed file is current", async () => {
    const { code } = await run({ check: true });

    expect(code).toBe(0);
  });

  it("fails --check when the file is missing", async () => {
    const { code, message } = await run({ check: true, out: scratch() });

    expect(code).toBe(1);
    expect(message).toContain("npm run api-types");
  });

  it("fails --check when the file is stale", async () => {
    const out = scratch();
    writeFileSync(out, "// stale\n");

    const { code, message } = await run({ check: true, out });

    expect(code).toBe(1);
    expect(message).toContain("is stale");
  });

  it("writes the rendered types when not checking", async () => {
    const out = scratch();

    const { code } = await run({ out });

    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(await renderTypes());
  });
});
