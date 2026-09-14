import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { expect, it } from "vitest";
import { useRestoredScroll } from "./use-restored-scroll";

function List() {
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useRestoredScroll(ref, "list");
  return (
    <div
      ref={ref}
      data-testid="list"
      style={{ overflowY: "auto", height: 100 }}
    >
      <div style={{ height: 1000 }}>Items</div>
      <button
        onClick={() => {
          void navigate("/other");
        }}
      >
        Open
      </button>
    </div>
  );
}
function Other() {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => {
        void navigate(-1);
      }}
    >
      Back
    </button>
  );
}
it("restores the previous history entry's own scroll container after remount", async () => {
  render(
    <MemoryRouter initialEntries={[{ pathname: "/", key: "scroll-test" }]}>
      <Routes>
        <Route path="/" element={<List />} />
        <Route path="/other" element={<Other />} />
      </Routes>
    </MemoryRouter>,
  );
  const list = screen.getByTestId("list");
  list.scrollTop = 450;
  fireEvent.scroll(list);
  await act(async () => {
    fireEvent.click(screen.getByText("Open"));
  });
  expect(screen.queryByTestId("list")).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByText("Back"));
  });
  expect(screen.getByTestId("list").scrollTop).toBe(450);
});
