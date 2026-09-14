import { act, renderHook } from "@testing-library/react";
import { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { expect, it } from "vitest";
import { useOverlayState } from "./use-overlay-state";

function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <MemoryRouter
      initialEntries={[
        {
          pathname: "/review",
          search: "?cameras=front",
          state: { severity: "alert" },
        },
      ]}
    >
      {children}
    </MemoryRouter>
  );
}
it("writes a recording cursor and its filter atomically without dropping other history state", async () => {
  const { result } = renderHook(
    () => {
      const [recording, setRecording] = useOverlayState<{ startTime: number }>(
        "recording",
      );
      return { recording, setRecording, location: useLocation() };
    },
    { wrapper: Wrapper },
  );
  await act(async () => {
    result.current.setRecording({ startTime: 123 }, true, {
      reviewFilter: { after: 123 },
    });
  });
  expect(result.current.location.state).toEqual({
    severity: "alert",
    recording: { startTime: 123 },
    reviewFilter: { after: 123 },
  });
  expect(result.current.location.search).toBe("?cameras=front");
  await act(async () => {
    result.current.setRecording(result.current.recording!, true, {
      reviewFilter: { after: 120 },
    });
  });
  expect(result.current.location.state).toEqual({
    severity: "alert",
    recording: { startTime: 123 },
    reviewFilter: { after: 120 },
  });
});
