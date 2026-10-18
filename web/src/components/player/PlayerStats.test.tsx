import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlayerStats } from "./PlayerStats";

const stats = {
  streamType: "MSE",
  bandwidth: 12.345,
  totalFrames: 100,
  droppedFrames: 3,
  decodedFrames: 97,
  droppedFrameRate: 3,
};

describe("PlayerStats", () => {
  it("names the playing stream and marks it as auto", () => {
    const { rerender } = render(
      <PlayerStats stats={stats} minimal={false} streamLabel="Main" />,
    );
    expect(screen.getByText("Main")).toBeInTheDocument();
    expect(screen.getByText("12.35 kBps")).toBeInTheDocument();
    expect(screen.getByText("3.00%")).toBeInTheDocument();

    rerender(
      <PlayerStats
        stats={stats}
        minimal={false}
        streamLabel="Main"
        streamAuto
      />,
    );
    expect(screen.queryByText("Main")).not.toBeInTheDocument();
    expect(screen.getByText("stats.streamAuto")).toBeInTheDocument();
  });

  it("omits the stream and missing counters", () => {
    render(
      <PlayerStats
        stats={{
          streamType: "jsmpeg",
          bandwidth: 0,
          totalFrames: 0,
          droppedFrames: undefined,
          decodedFrames: undefined,
          droppedFrameRate: undefined,
        }}
        minimal={false}
      />,
    );
    expect(screen.queryByText("stats.stream")).not.toBeInTheDocument();
    expect(
      screen.queryByText("stats.droppedFrames.title"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("stats.decodedFrames")).not.toBeInTheDocument();
  });

  it("shows the compact layout on tiles", () => {
    render(<PlayerStats stats={stats} minimal />);
    expect(
      screen.getByText("stats.droppedFrames.short.title"),
    ).toBeInTheDocument();
    expect(screen.queryByText("stats.totalFrames")).not.toBeInTheDocument();
  });
});
