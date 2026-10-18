"""B32 (upstream #24384): the QSV scale presets filter fps before vpp_qsv."""

import unittest

from frigate.ffmpeg_presets import parse_preset_hardware_acceleration_scale


class TestQsvScalePreset(unittest.TestCase):
    def test_qsv_presets_drop_frames_before_scaling(self):
        for preset in ("preset-intel-qsv-h264", "preset-intel-qsv-h265"):
            with self.subTest(preset=preset):
                args = parse_preset_hardware_acceleration_scale(
                    preset, [], 5, 1280, 720
                )
                filters = args[args.index("-vf") + 1]

                self.assertTrue(filters.startswith("fps=5,vpp_qsv=w=1280:h=720"))
                self.assertEqual(filters.count("fps="), 1)


if __name__ == "__main__":
    unittest.main()
