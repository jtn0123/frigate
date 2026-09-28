"""Tests for detector stats in frigate.stats.util."""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from frigate.detectors.device import parse_device, runner_names
from frigate.stats.util import _runner_device, get_detector_stats


def _runner(detector_type: str) -> SimpleNamespace:
    """A detection runner carrying only the fields get_detector_stats reads."""
    return SimpleNamespace(
        detect_process=None,
        detector_config=SimpleNamespace(type=detector_type),
        avg_inference_speed=SimpleNamespace(value=0.01),
        detection_start=SimpleNamespace(value=0.0),
    )


def _tracking(devices: list[str]) -> dict:
    """Stats tracking with one runner per device, named as start_detectors does."""
    specs = [parse_device(raw) for raw in devices]
    return {
        "detectors": {
            name: _runner(spec.detector)
            for name, spec in zip(runner_names(specs), specs)
        }
    }


def _temperatures(stats: dict) -> dict:
    return {name: stat.get("temperature") for name, stat in stats.items()}


class TestRunnerDevice(unittest.TestCase):
    def test_strips_repeat_suffix(self) -> None:
        self.assertEqual(_runner_device("hailo:PCIe#2"), "hailo:PCIe")
        self.assertEqual(_runner_device("hailo:PCIe#12"), "hailo:PCIe")

    def test_keeps_names_without_a_numeric_suffix(self) -> None:
        self.assertEqual(_runner_device("hailo:PCIe"), "hailo:PCIe")
        self.assertEqual(_runner_device("custom#name"), "custom#name")


class TestDetectorTemperatures(unittest.TestCase):
    @patch("frigate.stats.util.get_hardware_temperatures", return_value=[51.0])
    def test_repeated_device_shares_its_temperature(self, _temps) -> None:
        stats = get_detector_stats(_tracking(["hailo:PCIe", "hailo:PCIe"]))

        self.assertEqual(
            _temperatures(stats), {"hailo:PCIe": 51.0, "hailo:PCIe#2": 51.0}
        )

    @patch("frigate.stats.util.get_hardware_temperatures", return_value=[51.0, 52.0])
    def test_repeat_does_not_take_another_units_temperature(self, _temps) -> None:
        stats = get_detector_stats(_tracking(["hailo:PCIe", "hailo:PCIe"]))

        self.assertEqual(stats["hailo:PCIe#2"]["temperature"], 51.0)

    @patch(
        "frigate.stats.util.get_hardware_temperatures",
        side_effect=lambda detector_type: (
            [45.0, 55.0] if detector_type == "edgetpu" else [60.0]
        ),
    )
    def test_distinct_devices_keep_distinct_temperatures(self, _temps) -> None:
        stats = get_detector_stats(
            _tracking(
                [
                    "edgetpu:pci:0",
                    "hailo:PCIe",
                    "edgetpu:pci:1",
                    "edgetpu:pci:0",
                    "hailo:PCIe",
                ]
            )
        )

        self.assertEqual(
            _temperatures(stats),
            {
                "edgetpu:pci:0": 45.0,
                "hailo:PCIe": 60.0,
                "edgetpu:pci:1": 55.0,
                "edgetpu:pci:0#2": 45.0,
                "hailo:PCIe#2": 60.0,
            },
        )

    @patch("frigate.stats.util.get_hardware_temperatures", return_value=[])
    def test_no_temperature_when_unit_is_not_reported(self, _temps) -> None:
        stats = get_detector_stats(_tracking(["hailo:PCIe"]))

        self.assertNotIn("temperature", stats["hailo:PCIe"])
        self.assertEqual(stats["hailo:PCIe"]["inference_speed"], 10.0)


if __name__ == "__main__":
    unittest.main()
