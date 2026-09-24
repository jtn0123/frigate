"""`--validate-config` exits non-zero for an invalid config (upstream #24398)."""

import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from pydantic import BaseModel, ValidationError

from frigate import __main__ as frigate_main


class _Strict(BaseModel):
    port: int


def _validation_error() -> ValidationError:
    try:
        _Strict(port="not a number")
    except ValidationError as error:
        return error

    raise AssertionError("expected a validation error")


class TestValidateConfigExitCode(unittest.TestCase):
    def _run_main(self, load: MagicMock) -> int | str | None:
        with tempfile.TemporaryDirectory() as directory:
            config_path = os.path.join(directory, "config.yml")

            with open(config_path, "w") as f:
                f.write("port: not a number\n")

            with (
                patch.object(frigate_main.mp, "Manager"),
                patch.object(frigate_main.mp, "Event"),
                patch.object(frigate_main, "setup_logging"),
                patch.object(frigate_main.signal, "signal"),
                patch.object(frigate_main.faulthandler, "enable"),
                patch.object(
                    frigate_main, "find_config_file", return_value=config_path
                ),
                patch.object(frigate_main.FrigateConfig, "load", load),
                patch.object(frigate_main, "FrigateApp") as app,
                patch("sys.argv", ["frigate", "--validate-config"]),
                patch("builtins.print"),
                self.assertRaises(SystemExit) as exit_info,
            ):
                frigate_main.main()

        app.assert_not_called()
        return exit_info.exception.code

    def test_invalid_config_exits_with_failure(self):
        load = MagicMock(side_effect=_validation_error())

        self.assertEqual(self._run_main(load), 1)
        # the safe mode fallback is not tried when only validating
        load.assert_called_once()

    def test_valid_config_exits_with_success(self):
        self.assertEqual(self._run_main(MagicMock()), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
