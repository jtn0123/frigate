import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("workers inherit the running preview reservation @mobile", async ({
  request,
  baseURL,
}) => {
  const record = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../..",
    ".e2e-port",
  );
  const port = readFileSync(record, "utf-8").trim();
  expect(process.env["E2E_PORT"]).toBe(port);
  expect(baseURL).toBe(`http://localhost:${port}`);
  const response = await request.get("/");
  expect(response.status()).toBe(200);
});
