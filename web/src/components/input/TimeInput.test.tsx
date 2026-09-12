import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeInput } from "./TimeInput";

const device = vi.hoisted(() => ({ isIOS: false }));
vi.mock("react-device-detect", () => device);
afterEach(cleanup);

describe("TimeInput", () => {
  it.each([
    { ios: false, clock: "09:18:37", seconds: 37, step: "1" },
    { ios: false, clock: "09:18", seconds: 0, step: "1" },
    { ios: true, clock: "09:18", seconds: 0, step: "60" },
  ])(
    "preserves the selected date for $clock (iOS: $ios)",
    ({ ios, clock, seconds, step }) => {
      device.isIOS = ios;
      const date = new Date(2026, 8, 12, 7, 4, 3, 999);
      const onChange = vi.fn();
      const { getByLabelText } = render(
        <TimeInput
          id="time"
          label="Select time"
          value="07:04:03"
          timestamp={date.getTime() / 1000}
          onChange={onChange}
        />,
      );
      const input = getByLabelText("Select time");
      expect(input.getAttribute("step")).toBe(step);
      fireEvent.change(input, { target: { value: clock } });
      expect(onChange).toHaveBeenCalledWith(
        new Date(2026, 8, 12, 9, 18, seconds).getTime() / 1000,
      );
    },
  );
});
