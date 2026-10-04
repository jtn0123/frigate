import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { useSeenElsewhere } from "@/hooks/fork/use-seen-elsewhere";
import type { Sighting } from "@/lib/fork/seen-elsewhere";
import type { SearchResult } from "@/types/search";
import SeenElsewhere from "./SeenElsewhere";

type Seen = ReturnType<typeof useSeenElsewhere>;

let seen: Partial<Seen>;
let isAdmin = true;

vi.mock("@/hooks/fork/use-seen-elsewhere", () => ({
  useSeenElsewhere: () => seen,
}));
vi.mock("@/hooks/use-is-admin", () => ({
  useIsAdmin: () => isAdmin,
}));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: "en" },
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

// 2026-06-05 10:00:00 UTC
const T = 1780653600;

function event(id: string, camera: string, start: number): SearchResult {
  return {
    id,
    camera,
    start_time: start,
    end_time: start + 30,
    label: "person",
    sub_label: "Alice",
    score: 0.9,
    has_snapshot: true,
    has_clip: true,
    zones: [],
    search_source: "thumbnail",
    search_distance: 0,
    top_score: 0.9,
    data: {
      top_score: 0.9,
      score: 0.9,
      region: [],
      box: [],
      area: 0,
      ratio: 1,
      type: "object",
      average_estimated_speed: 0,
      velocity_angle: 0,
      path_data: [],
    },
  };
}

const CURRENT = event("cur", "front_door", T);

function sighting(id: string, offset: number): Sighting {
  return {
    event: event(id, "garage", T + offset),
    reasons: ["name"],
    offset,
  };
}

function answered(overrides: Partial<Seen> = {}): Partial<Seen> {
  return {
    config: undefined,
    identities: [{ kind: "name", value: "Alice", param: "Alice" }],
    range: { after: T - 1800, before: T + 1830, pivot: T, live: false },
    current: {
      id: CURRENT.id,
      camera: CURRENT.camera,
      start_time: CURRENT.start_time,
      end_time: T + 30,
    },
    now: T + 60,
    canSimilar: false,
    active: true,
    setup: undefined,
    matched: [sighting("a", -120), sighting("b", 240)],
    similar: [],
    capped: false,
    loadingMatched: false,
    loadingSimilar: false,
    refreshing: false,
    failed: false,
    ...overrides,
  };
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <SeenElsewhere search={CURRENT} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  isAdmin = true;
  seen = answered();
});

describe("SeenElsewhere", () => {
  it("counts the sightings when every one fits", () => {
    renderPanel();
    expect(screen.getByTestId("seen-elsewhere-summary")).toHaveTextContent(
      'seenElsewhere.summary:{"count":2}',
    );
  });

  it("says the list holds only the closest sightings when a read came back full", () => {
    seen = answered({ capped: true });
    renderPanel();
    expect(screen.getByTestId("seen-elsewhere-summary")).toHaveTextContent(
      'seenElsewhere.capped:{"count":2}',
    );
  });

  it("tells an admin which setting would let it look", () => {
    seen = answered({ active: false, setup: "face" });
    renderPanel();
    expect(screen.queryByTestId("seen-elsewhere")).not.toBeInTheDocument();
    const line = screen.getByTestId("seen-elsewhere-setup");
    expect(line).toHaveAttribute("data-setup", "face");
    expect(line).toHaveTextContent("seenElsewhere.setup.face");
  });

  it("stays hidden from a viewer, who cannot change settings", () => {
    isAdmin = false;
    seen = answered({ active: false, setup: "face" });
    const { container } = renderPanel();
    expect(container).toBeEmptyDOMElement();
  });

  it("stays hidden when no setting would help", () => {
    seen = answered({ active: false, setup: undefined });
    const { container } = renderPanel();
    expect(container).toBeEmptyDOMElement();
  });
});
