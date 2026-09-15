import { fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
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
function Tabs() {
  const ref = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState("alerts");
  useRestoredScroll(ref, tab);
  return (
    <>
      <button
        onClick={() => setTab(tab === "alerts" ? "detections" : "alerts")}
      >
        Switch
      </button>
      <div
        ref={ref}
        data-testid="tabs"
        style={{ overflowY: "auto", height: 100 }}
      >
        <div data-height={tab === "alerts" ? 1000 : 100}>{tab}</div>
      </div>
    </>
  );
}

/** Clamp scrollTop to the content like a browser does after layout. */
function clampLikeABrowser(element: HTMLElement) {
  let stored = 0;
  const max = () =>
    Math.max(
      0,
      Number(element.firstElementChild?.getAttribute("data-height") ?? 0) - 100,
    );
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => {
      stored = Math.min(stored, max());
      return stored;
    },
    set: (value: number) => {
      stored = Math.min(Math.max(0, value), max());
    },
  });
}

it("keeps a scope's position when the next scope renders shorter content", () => {
  render(
    <MemoryRouter initialEntries={[{ pathname: "/", key: "tabs-test" }]}>
      <Tabs />
    </MemoryRouter>,
  );
  const list = screen.getByTestId("tabs");
  clampLikeABrowser(list);
  list.scrollTop = 450;
  fireEvent.scroll(list);
  expect(list.scrollTop).toBe(450);

  fireEvent.click(screen.getByText("Switch"));
  expect(list.textContent).toBe("detections");
  fireEvent.click(screen.getByText("Switch"));

  expect(list.textContent).toBe("alerts");
  expect(list.scrollTop).toBe(450);
});

it("restores the previous history entry's own scroll container after remount", () => {
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
  fireEvent.click(screen.getByText("Open"));
  expect(screen.queryByTestId("list")).toBeNull();
  fireEvent.click(screen.getByText("Back"));
  expect(screen.getByTestId("list").scrollTop).toBe(450);
});
