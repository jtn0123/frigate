import { renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { FrigateConfig } from "@/types/frigateConfig";
import {
  isStalePendingKey,
  usePruneSettingsState,
} from "./use-prune-settings-state";

const cfg = (value: unknown) => value as FrigateConfig;

const both = cfg({
  cameras: { front: {}, back: {} },
  profiles: { armed: {}, away: {} },
});

type Props = { config: FrigateConfig | undefined };

function setup(
  editing: Record<string, string | null>,
  pending: Record<string, object>,
  { config }: Props = { config: both },
) {
  return renderHook(
    (props: Props) => {
      const [editingProfile, setEditingProfile] = useState(editing);
      const [pendingData, setPendingData] = useState(pending);
      usePruneSettingsState(props.config, setEditingProfile, setPendingData);
      return { editingProfile, pendingData };
    },
    { initialProps: { config } },
  );
}

describe("usePruneSettingsState", () => {
  it("drops edits for a deleted profile and keeps the rest", () => {
    const { result, rerender } = setup(
      { front: "armed", back: "away" },
      {
        detect: { fps: 5 },
        "front::detect": { fps: 10 },
        "front::profiles.armed.detect": { fps: 1 },
        "back::profiles.away.review": {},
      },
    );

    rerender({
      config: cfg({ cameras: both.cameras, profiles: { away: {} } }),
    });

    expect(result.current.editingProfile).toEqual({ back: "away" });
    expect(Object.keys(result.current.pendingData)).toEqual([
      "detect",
      "front::detect",
      "back::profiles.away.review",
    ]);
  });

  it("drops edits for a deleted camera", () => {
    const { result, rerender } = setup(
      { back: "armed" },
      { "back::record": {}, "front::record": {} },
    );

    rerender({ config: cfg({ cameras: { front: {} }, profiles: {} }) });

    expect(result.current.editingProfile).toEqual({});
    expect(Object.keys(result.current.pendingData)).toEqual(["front::record"]);
  });

  it("keeps the same state objects when nothing is stale", () => {
    const { result, rerender } = setup(
      { front: null },
      { "front::profiles.armed.detect": {} },
    );
    const before = result.current;

    rerender({ config: cfg({ ...both }) });

    expect(result.current.editingProfile).toBe(before.editingProfile);
    expect(result.current.pendingData).toBe(before.pendingData);
  });

  it("waits for the config before pruning", () => {
    const { result } = setup(
      { x: "gone" },
      { "x::detect": {} },
      { config: undefined },
    );
    expect(result.current.editingProfile).toEqual({ x: "gone" });
    expect(result.current.pendingData).toEqual({ "x::detect": {} });
  });
});

describe("isStalePendingKey", () => {
  const names = { cameras: new Set(["front"]), profiles: new Set(["armed"]) };

  it("never treats a global section as stale", () => {
    expect(isStalePendingKey("profiles", names)).toBe(false);
    expect(isStalePendingKey("go2rtc_streams", names)).toBe(false);
  });

  it("checks the camera and the profile a camera key names", () => {
    expect(isStalePendingKey("front::profiles.armed.detect", names)).toBe(
      false,
    );
    expect(isStalePendingKey("front::profiles.gone.detect", names)).toBe(true);
    expect(isStalePendingKey("back::detect", names)).toBe(true);
  });
});
