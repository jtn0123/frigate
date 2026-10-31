import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ base: "http://frigate.local:5000/" }));
vi.mock("@/api/baseUrl", () => ({
  get baseUrl() {
    return h.base;
  },
}));

import { createRecordingReviewUrl } from "../recordingReviewUrl";

const state = { camera: "front_door", timestamp: 1_700_000_000.75 };

describe("createRecordingReviewUrl (fork UI155)", () => {
  afterEach(() => {
    h.base = "http://frigate.local:5000/";
  });

  it("builds the link at the root", () => {
    expect(createRecordingReviewUrl("/review", state)).toBe(
      "http://frigate.local:5000/review?timestamp=front_door_1700000000",
    );
    expect(createRecordingReviewUrl("review", state)).toBe(
      "http://frigate.local:5000/review?timestamp=front_door_1700000000",
    );
  });

  it("keeps the base path Frigate is served under", () => {
    h.base = "https://ha.local/api/hassio_ingress/abc123/";
    expect(createRecordingReviewUrl("/review", state)).toBe(
      "https://ha.local/api/hassio_ingress/abc123/review?timestamp=front_door_1700000000",
    );
  });

  it("keeps a base path given without its trailing slash", () => {
    h.base = "https://ha.local/frigate";
    expect(createRecordingReviewUrl("/review", state)).toBe(
      "https://ha.local/frigate/review?timestamp=front_door_1700000000",
    );
  });
});
