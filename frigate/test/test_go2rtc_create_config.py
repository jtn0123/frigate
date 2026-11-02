"""Tests for the go2rtc config written by the startup script."""

import os
import runpy
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from typing import Any
from unittest.mock import patch

from ruamel.yaml import YAML

from frigate.util.config import resolve_ffmpeg_path

# Always the checkout's copy: the base image's /usr/local/go2rtc copy is the
# released script, so testing it would pass or fail regardless of this tree.
SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "docker/main/rootfs/usr/local/go2rtc/create_config.py"
)

DEFAULT_FFMPEG = resolve_ffmpeg_path("default", "ffmpeg")


def _dump(data: dict[str, Any]) -> str:
    out = StringIO()
    YAML().dump(data, out)
    return out.getvalue()


class TestGo2rtcCreateConfig(unittest.TestCase):
    def setUp(self):
        env_patch = patch.dict(os.environ)
        env_patch.start()
        self.addCleanup(env_patch.stop)
        os.environ.pop("GO2RTC_ALLOW_ARBITRARY_EXEC", None)

        exec_patch = patch("frigate.util.services._GO2RTC_ARBITRARY_EXEC_ENV", None)
        exec_patch.start()
        self.addCleanup(exec_patch.stop)

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.config_path = os.path.join(tmp.name, "config.yml")
        os.environ["CONFIG_FILE"] = self.config_path

    def _run(self, config: dict[str, Any]) -> dict[str, Any]:
        with open(self.config_path, "w") as f:
            f.write(_dump(config))

        with (
            patch("frigate.util.atomic.write_private_file") as write,
            patch("sys.stdout", new_callable=StringIO),
        ):
            runpy.run_path(str(SCRIPT), run_name="__main__")

        write.assert_called_once()
        path, content = write.call_args.args
        self.assertEqual(path, Path("/dev/shm/go2rtc.yaml"))
        return YAML(typ="safe").load(content)

    def test_ffmpeg_bin_override_is_replaced(self):
        output = self._run(
            {"go2rtc": {"ffmpeg": {"bin": "/bin/sh", "global": "-hide_banner"}}}
        )
        self.assertEqual(output["ffmpeg"]["bin"], DEFAULT_FFMPEG)
        # templates already in the config file keep working
        self.assertEqual(output["ffmpeg"]["global"], "-hide_banner")

    def test_ngrok_is_dropped(self):
        output = self._run({"go2rtc": {"ngrok": {"command": "/bin/sh -c id"}}})
        self.assertNotIn("ngrok", output)

    def test_unsafe_ffmpeg_path_falls_back_to_default(self):
        output = self._run({"ffmpeg": {"path": "/bin/sh -c id;#"}})
        self.assertEqual(output["ffmpeg"]["bin"], DEFAULT_FFMPEG)

    def test_exec_options_kept_when_override_set(self):
        with patch("frigate.util.services._GO2RTC_ARBITRARY_EXEC_ENV", "true"):
            output = self._run(
                {
                    "go2rtc": {
                        "ffmpeg": {"bin": "/usr/bin/ffmpeg"},
                        "ngrok": {"command": "ngrok tcp 8555"},
                    }
                }
            )
        self.assertEqual(output["ffmpeg"]["bin"], "/usr/bin/ffmpeg")
        self.assertEqual(output["ngrok"], {"command": "ngrok tcp 8555"})

    def test_var_expansion_sources_are_removed(self):
        output = self._run(
            {
                "go2rtc": {
                    "streams": {
                        "plain": "${NOPE:exec:id}",
                        # Frigate collapses {{ to {, which used to skip the check
                        "escaped": "${{NOPE:exec:id}}",
                        "mixed": ["rtsp://camera/main", "${NOPE:exec:id}"],
                        "safe": "rtsp://camera/main",
                    }
                }
            }
        )
        streams = output["streams"]
        self.assertNotIn("plain", streams)
        self.assertNotIn("escaped", streams)
        self.assertEqual(streams["mixed"], ["rtsp://camera/main"])
        self.assertEqual(streams["safe"], "rtsp://camera/main")

    def test_transcode_of_var_expansion_stream_name_is_removed(self):
        # go2rtc expands ${...} anywhere in its config, so a stream name that
        # carries one must not reach a generated ffmpeg: source
        unsafe_name = "${NOPE:front#raw=-y}"
        camera = {
            "ffmpeg": {"inputs": [{"path": "rtsp://camera/main", "roles": ["detect"]}]},
            "live": {"transcode": {"enabled": True}},
        }
        output = self._run(
            {
                "go2rtc": {
                    "streams": {
                        unsafe_name: "rtsp://camera/main",
                        "back": "rtsp://camera/back",
                    }
                },
                "cameras": {
                    "front": camera
                    | {"live": camera["live"] | {"streams": {"main": unsafe_name}}},
                    "back": camera,
                },
            }
        )
        streams = output["streams"]
        self.assertFalse(
            any(name.startswith("front_transcode_") for name in streams), streams
        )
        self.assertTrue(
            any(name.startswith("back_transcode_") for name in streams), streams
        )


if __name__ == "__main__":
    unittest.main()
