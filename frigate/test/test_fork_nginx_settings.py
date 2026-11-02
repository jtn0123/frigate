"""Tests for the listen parsing in nginx's startup settings script (E33).

The script runs in-process through runpy so coverage measures it. It reads the
config named by CONFIG_FILE and prints the nginx settings as JSON.
"""

import contextlib
import io
import json
import os
import runpy
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "docker/main/rootfs/usr/local/nginx/get_nginx_settings.py"
)


class TestGetNginxSettings(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def _run(self, config_text: str | None, name: str = "config.yml"):
        """Run the script and return (exit code, stdout, stderr)."""
        config_path = os.path.join(self.tmp.name, name)
        if config_text is not None:
            Path(config_path).write_text(config_text)

        stdout, stderr = io.StringIO(), io.StringIO()
        env = {"CONFIG_FILE": config_path}
        code = 0
        with (
            patch.dict(os.environ, env),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            os.environ.pop("FRIGATE_BASE_PATH", None)
            try:
                runpy.run_path(str(SCRIPT))
            except SystemExit as exit_:
                code = exit_.code

        return code, stdout.getvalue(), stderr.getvalue()

    def _settings(self, config_text: str | None, **kwargs) -> dict[str, Any]:
        code, out, err = self._run(config_text, **kwargs)
        self.assertEqual(code, 0, err)
        return json.loads(out)

    def test_missing_config_uses_default_ports(self):
        settings = self._settings(None)

        self.assertEqual(
            settings["listen"],
            {
                "internal": 5000,
                "internal_port": 5000,
                "external": 8971,
                "external_port": 8971,
            },
        )
        self.assertTrue(settings["tls"]["enabled"])
        self.assertFalse(settings["ipv6"]["enabled"])
        self.assertEqual(settings["base_path"], "")

    def test_valid_listen_values_are_normalized(self):
        settings = self._settings(
            "networking:\n"
            "  listen:\n"
            "    internal: ' 127.0.0.1:5001 '\n"
            "    external: '[2001:DB8:0:0::1]:8443'\n"
        )

        listen = settings["listen"]
        self.assertEqual(listen["internal"], "127.0.0.1:5001")
        self.assertEqual(listen["internal_port"], 5001)
        self.assertEqual(listen["external"], "[2001:db8::1]:8443")
        self.assertEqual(listen["external_port"], 8443)

    def test_json_config_is_read(self):
        settings = self._settings(
            json.dumps({"networking": {"listen": {"internal": "5002"}}}),
            name="config.json",
        )

        self.assertEqual(settings["listen"]["internal"], 5002)
        self.assertEqual(settings["listen"]["internal_port"], 5002)

    def test_invalid_value_falls_back_to_default(self):
        code, out, err = self._run(
            "networking:\n"
            "  listen:\n"
            "    internal: '5000; include /etc/passwd'\n"
            "    external: true\n"
        )

        self.assertEqual(code, 0, err)
        self.assertIn("[WARN] Invalid networking.listen.internal, using 5000", err)
        self.assertIn("[WARN] Invalid networking.listen.external, using 8971", err)
        listen = json.loads(out)["listen"]
        self.assertEqual(listen["internal"], 5000)
        self.assertEqual(listen["internal_port"], 5000)
        self.assertEqual(listen["external"], 8971)
        self.assertEqual(listen["external_port"], 8971)

    def test_valid_value_is_kept_when_the_other_falls_back(self):
        # a fallback must never widen the internal listener beyond its address
        code, out, err = self._run(
            "networking:\n"
            "  listen:\n"
            "    internal: '127.0.0.1:5005'\n"
            "    external: 'not a port'\n"
        )

        self.assertEqual(code, 0, err)
        listen = json.loads(out)["listen"]
        self.assertEqual(listen["internal"], "127.0.0.1:5005")
        self.assertEqual(listen["external"], 8971)

    def test_shared_port_exits(self):
        code, out, err = self._run(
            "networking:\n  listen:\n    internal: '127.0.0.1:8971'\n"
        )

        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn(
            "[ERROR] networking.listen.internal and external share a port", err
        )

    def test_fallback_onto_the_other_port_exits(self):
        code, out, err = self._run(
            "networking:\n  listen:\n    internal: 0\n    external: 5000\n"
        )

        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("[WARN] Invalid networking.listen.internal, using 5000", err)
        self.assertIn("share a port", err)


if __name__ == "__main__":
    unittest.main(verbosity=2)
