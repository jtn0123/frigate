import threading
import unittest
from types import SimpleNamespace
from typing import cast
from unittest.mock import MagicMock, patch

from frigate.config import FrigateConfig
from frigate.embeddings import EmbeddingProcess
from frigate.embeddings.transcription_preload import preload_transcription_runtime

IMPORT_MODULE = "frigate.embeddings.transcription_preload.importlib.import_module"


def _camera(enabled: bool = True, transcription: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        enabled_in_config=enabled,
        audio_transcription=SimpleNamespace(enabled=transcription),
    )


def _config(*cameras: SimpleNamespace) -> FrigateConfig:
    return cast(
        FrigateConfig,
        SimpleNamespace(
            cameras={f"cam{i}": camera for i, camera in enumerate(cameras)},
            logger=None,
        ),
    )


class TestPreloadTranscriptionRuntime(unittest.TestCase):
    @patch(IMPORT_MODULE)
    def test_imports_ctranslate2_when_a_camera_transcribes(self, import_module):
        config = _config(_camera(transcription=False), _camera())

        self.assertTrue(preload_transcription_runtime(config))
        import_module.assert_called_once_with("ctranslate2")

    @patch(IMPORT_MODULE)
    def test_skips_import_when_no_camera_transcribes(self, import_module):
        config = _config(_camera(transcription=False))

        self.assertFalse(preload_transcription_runtime(config))
        import_module.assert_not_called()

    @patch(IMPORT_MODULE)
    def test_ignores_transcription_on_disabled_cameras(self, import_module):
        config = _config(_camera(enabled=False))

        self.assertFalse(preload_transcription_runtime(config))
        import_module.assert_not_called()

    @patch(IMPORT_MODULE, side_effect=ImportError("no ctranslate2"))
    def test_missing_ctranslate2_logs_instead_of_raising(self, _import_module):
        config = _config(_camera())

        with self.assertLogs(
            "frigate.embeddings.transcription_preload", level="WARNING"
        ):
            self.assertFalse(preload_transcription_runtime(config))


class TestEmbeddingProcessPreloadOrder(unittest.TestCase):
    def test_preloads_before_the_maintainer_creates_onnx_sessions(self):
        order: list[str] = []
        stop_event = threading.Event()
        stop_event.set()
        process = EmbeddingProcess(_config(_camera()), MagicMock(), stop_event)

        with (
            patch.object(EmbeddingProcess, "pre_run_setup"),
            patch(
                "frigate.embeddings.preload_transcription_runtime",
                side_effect=lambda _config: order.append("preload"),
            ),
            patch(
                "frigate.embeddings.EmbeddingMaintainer",
                side_effect=lambda *_args: order.append("maintainer") or MagicMock(),
            ),
        ):
            process.run()

        self.assertEqual(order, ["preload", "maintainer"])


if __name__ == "__main__":
    unittest.main()
