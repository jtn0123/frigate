import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { DetectionHardware } from "@/types/hardware";
import { HardwarePicker } from "./HardwarePicker";

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { scene?: string }) =>
      options?.scene ? `${key}:${options.scene}` : key,
  }),
}));

const probe = vi.hoisted(() => ({ data: [] as DetectionHardware[] }));

vi.mock("swr", () => ({
  default: () => ({ data: probe.data, isLoading: false }),
}));

const INTEL_GPU: DetectionHardware = {
  key: "openvino:GPU",
  detector: "openvino",
  name: "Intel GPU",
  units: [{ device: "openvino:GPU", label: "0000:00:02.0" }],
  count: 1,
  unlimited: true,
};

const MULTI_GPU: DetectionHardware = {
  key: "openvino:GPU",
  detector: "openvino",
  name: "Intel GPU",
  units: [
    { device: "openvino:GPU.0", label: "0000:00:02.0" },
    { device: "openvino:GPU.1", label: "0000:03:00.0" },
  ],
  count: 2,
  unlimited: true,
};

const CPU: DetectionHardware = {
  key: "cpu",
  detector: "cpu",
  name: "CPU",
  units: [{ device: "cpu", label: "CPU" }],
  count: 1,
  unlimited: true,
};

const CORAL_PCI: DetectionHardware = {
  key: "edgetpu:pci",
  detector: "edgetpu",
  name: "Coral EdgeTPU (PCIe)",
  units: [
    { device: "edgetpu:pci:0", label: "PCIe 0" },
    { device: "edgetpu:pci:1", label: "PCIe 1" },
  ],
  count: 2,
  unlimited: false,
};

beforeEach(() => {
  probe.data = [INTEL_GPU, CPU, CORAL_PCI];
});

function renderPicker(
  claimedElsewhere: Record<string, string>,
  devices: string[] = [],
) {
  const onChange = vi.fn();
  render(
    <HardwarePicker
      idPrefix="model-1"
      devices={devices}
      claimedElsewhere={claimedElsewhere}
      cameraCount={1}
      onChange={onChange}
    />,
  );
  return onChange;
}

function pick(name: string) {
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name }));
}

it("lets a second model pick a shared GPU another model already uses", () => {
  const onChange = renderPicker({ "openvino:GPU": "all" });
  pick("Intel GPU");
  expect(onChange).toHaveBeenLastCalledWith(["openvino:GPU"]);
});

it("lets a second model pick the CPU another model already uses", () => {
  const onChange = renderPicker({ cpu: "all" });
  pick("CPU");
  expect(onChange).toHaveBeenLastCalledWith(["cpu"]);
});

it("keeps shared GPU units selectable and unlabeled when another model uses them", () => {
  probe.data = [MULTI_GPU];
  renderPicker({ "openvino:GPU.0": "all" }, ["openvino:GPU.1"]);
  expect(
    screen.getByRole("checkbox", { name: /0000:00:02\.0/ }),
  ).not.toBeDisabled();
  expect(
    screen.queryByText("detectionModels.hardware.claimedBy:all"),
  ).not.toBeInTheDocument();
});

it("skips a Coral unit another model claimed and keeps it exclusive", () => {
  const onChange = renderPicker({ "edgetpu:pci:0": "all" });
  pick("Coral EdgeTPU (PCIe) (2)");
  expect(onChange).toHaveBeenLastCalledWith(["edgetpu:pci:1"]);
});

it("disables and labels a Coral unit another model claimed", () => {
  renderPicker({ "edgetpu:pci:0": "all" }, ["edgetpu:pci:1"]);
  expect(screen.getByRole("checkbox", { name: /PCIe 0/ })).toBeDisabled();
  expect(
    screen.getByText("detectionModels.hardware.claimedBy:all"),
  ).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: /PCIe 1/ })).not.toBeDisabled();
});

it("clears the devices when every Coral unit is claimed by other models", () => {
  const onChange = renderPicker({
    "edgetpu:pci:0": "all",
    "edgetpu:pci:1": "street",
  });
  pick("Coral EdgeTPU (PCIe) (2)");
  expect(onChange).toHaveBeenLastCalledWith([]);
});
