"""Tests for get_hailo_temps when the HailoRT runtime cannot be loaded."""

import builtins
import sys
import unittest
from unittest.mock import patch

from frigate.util import services

_real_import = builtins.__import__


def failing_import(error: BaseException):
    """An __import__ that raises error for hailo_platform only."""

    def fake_import(name, *args, **kwargs):
        if name == "hailo_platform":
            raise error

        return _real_import(name, *args, **kwargs)

    return fake_import


class TestHailoTemps(unittest.TestCase):
    def setUp(self) -> None:
        patches = [
            patch.object(services, "_hailo_import_failed", False),
            # a cached module would skip the import under test
            patch.dict(sys.modules),
        ]

        for p in patches:
            p.start()
            self.addCleanup(p.stop)

        sys.modules.pop("hailo_platform", None)

    def test_missing_module_returns_nothing_quietly(self):
        with (
            patch("builtins.__import__", failing_import(ModuleNotFoundError("x"))),
            self.assertNoLogs(services.logger, level="WARNING"),
        ):
            self.assertEqual(services.get_hailo_temps(), {})

    def test_broken_runtime_returns_nothing_and_logs_once(self):
        for error in (
            ImportError("libhailort.so.4.23.0: cannot open shared object file"),
            OSError("libhailort.so: wrong ELF class"),
        ):
            with self.subTest(error=type(error).__name__):
                with (
                    patch.object(services, "_hailo_import_failed", False),
                    patch("builtins.__import__", failing_import(error)),
                    self.assertLogs(services.logger, level="WARNING") as logs,
                ):
                    self.assertEqual(services.get_hailo_temps(), {})
                    self.assertEqual(services.get_hailo_temps(), {})

                self.assertEqual(len(logs.records), 1)
                self.assertIn(str(error), logs.output[0])


if __name__ == "__main__":
    unittest.main()
