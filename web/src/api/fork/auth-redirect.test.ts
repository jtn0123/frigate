import { afterEach, describe, expect, it } from "vitest";
import { getLoginUrl, getPostLoginUrl } from "@/api/auth-redirect";
import { baseUrl } from "@/api/baseUrl";

// UI147 (upstream #24637): a deep link survives the trip through the login page

function visit(path: string) {
  window.history.pushState({}, "", path);
}

describe("getLoginUrl", () => {
  afterEach(() => visit("/"));

  it("carries the current path, query and hash", () => {
    visit("/review?camera=front#detail");
    const url = new URL(getLoginUrl());
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("redirect")).toBe(
      "/review?camera=front#detail",
    );
  });

  it("leaves the home page out", () => {
    visit("/");
    expect(new URL(getLoginUrl()).searchParams.has("redirect")).toBe(false);
  });

  it("honors a relative login page from the server", () => {
    visit("/system#storage");
    const url = new URL(getLoginUrl("login"));
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("redirect")).toBe("/system#storage");
  });

  it("returns an external login page untouched", () => {
    visit("/review");
    expect(getLoginUrl("https://auth.example.com/sign-in")).toBe(
      "https://auth.example.com/sign-in",
    );
  });
});

describe("getPostLoginUrl", () => {
  afterEach(() => visit("/"));

  it("defaults to the home page", () => {
    visit("/login");
    expect(getPostLoginUrl()).toBe(baseUrl);
  });

  it("returns to a same-origin target", () => {
    visit(`/login?redirect=${encodeURIComponent("/review?camera=front")}`);
    expect(getPostLoginUrl()).toBe(
      `${window.location.origin}/review?camera=front`,
    );
  });

  it.each([
    "https://evil.example.com/",
    "//evil.example.com/path",
    "javascript:alert(1)",
  ])("refuses the off-site target %s", (target) => {
    visit(`/login?redirect=${encodeURIComponent(target)}`);
    expect(getPostLoginUrl()).toBe(baseUrl);
  });
});
