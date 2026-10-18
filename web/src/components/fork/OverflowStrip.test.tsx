import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import OverflowStrip from "./OverflowStrip";

// UI149 (upstream #24543): jsdom does no layout, so each element reports the
// width in its data-w attribute and sits right after its previous siblings.
// The strip's wrapper reports `wrapperWidth`.

let wrapperWidth = 0;
const descriptors: Record<string, PropertyDescriptor | undefined> = {};

function widthOf(el: HTMLElement): number {
  return Number(el.dataset["w"] ?? 40);
}

beforeEach(() => {
  for (const key of ["offsetWidth", "offsetLeft", "clientWidth"]) {
    descriptors[key] = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      key,
    );
  }
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return widthOf(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
    configurable: true,
    get(this: HTMLElement) {
      let left = 0;
      let sibling = this.previousElementSibling as HTMLElement | null;
      while (sibling) {
        left += widthOf(sibling);
        sibling = sibling.previousElementSibling as HTMLElement | null;
      }
      return left;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return wrapperWidth;
    },
  });
});

afterEach(() => {
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, key, descriptor);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, key);
    }
  }
});

function items(count: number) {
  return Array.from({ length: count }, (_, i) => (
    <button key={i} type="button" data-w="50" aria-label={`Item ${i}`}>
      {`Item ${i}`}
    </button>
  ));
}

async function expectClosed() {
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Show less" }),
    ).not.toBeInTheDocument(),
  );
}

function renderStrip(count: number, activeIndex = 0) {
  return render(
    <OverflowStrip
      items={items(count)}
      activeIndex={activeIndex}
      showAllLabel="Show all"
      showLessLabel="Show less"
    />,
  );
}

describe("OverflowStrip", () => {
  it("shows every item and no kebab when they all fit", () => {
    wrapperWidth = 500;
    renderStrip(4);

    expect(screen.getAllByRole("button", { name: /^Item/ })).toHaveLength(4);
    expect(
      screen.queryByRole("button", { name: "Show all" }),
    ).not.toBeInTheDocument();
  });

  it("shows only the items that fit next to the kebab", () => {
    // 6 items of 50px in 200px: the kebab (40px) and the gap leave 156px
    wrapperWidth = 200;
    renderStrip(6);

    const visible = screen.getAllByRole("button", { name: /^Item/ });
    expect(visible.map((el) => el.textContent)).toEqual([
      "Item 0",
      "Item 1",
      "Item 2",
    ]);
    expect(screen.getByRole("button", { name: "Show all" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps an active item past the cut in the last visible slot", () => {
    wrapperWidth = 200;
    renderStrip(6, 5);

    expect(
      screen
        .getAllByRole("button", { name: /^Item/ })
        .map((el) => el.textContent),
    ).toEqual(["Item 0", "Item 1", "Item 5"]);
  });

  it("always shows at least one item", () => {
    wrapperWidth = 60;
    renderStrip(3);

    expect(screen.getAllByRole("button", { name: /^Item/ })).toHaveLength(1);
  });

  it("the kebab opens a panel with every item, which Show less closes", async () => {
    wrapperWidth = 200;
    renderStrip(6);

    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByRole("button", { name: "Item 5" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    await expectClosed();
  });

  it("picking an item or pressing Escape closes the panel", async () => {
    wrapperWidth = 200;
    renderStrip(6);

    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Item 4" }), {
      key: "Enter",
    });
    expect(screen.getByRole("button", { name: "Show less" })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("button", { name: "Item 4" }), {
      key: "Escape",
    });
    await expectClosed();

    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    fireEvent.click(screen.getByRole("button", { name: "Item 5" }));
    await expectClosed();
  });

  it("leaves the item labels off the measuring copy", () => {
    wrapperWidth = 500;
    const { container } = renderStrip(2);

    const hidden = container.querySelector("[aria-hidden]");
    expect(hidden?.querySelector("[aria-label]")).toBeNull();
    expect(hidden?.textContent).toContain("Item 1");
  });

  it("renders rows through renderRow", () => {
    wrapperWidth = 500;
    render(
      <OverflowStrip
        items={items(2)}
        showAllLabel="Show all"
        showLessLabel="Show less"
        renderRow={({ ref, className, children }) => (
          <div ref={ref} className={className} role="radiogroup">
            {children}
          </div>
        )}
      />,
    );

    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
  });
});
