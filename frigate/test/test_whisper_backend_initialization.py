"""Backend constructors must accept the shared Whisper loading arguments."""

import unittest
from unittest.mock import MagicMock, patch

from frigate.data_processing.real_time.whisper_online import (
    FasterWhisperASR,
    MLXWhisper,
    WhisperTimestampedASR,
)


class TestWhisperBackendInitialization(unittest.TestCase):
    def test_timestamped_backend_accepts_shared_arguments(self):
        """The timestamped backend must initialize and honor its device."""
        whisper = MagicMock()
        timestamped = MagicMock()
        with patch.dict(
            "sys.modules", {"whisper": whisper, "whisper_timestamped": timestamped}
        ):
            backend = WhisperTimestampedASR(
                "en", modelsize="tiny", cache_dir="/cache", device="cpu"
            )

        self.assertIs(backend.model, whisper.load_model.return_value)
        whisper.load_model.assert_called_once_with(
            "tiny", download_root="/cache", device="cpu"
        )

    def test_mlx_backend_accepts_shared_arguments(self):
        """MLX uses its own device handling but accepts the common interface."""
        mlx = MagicMock()
        transcribe = MagicMock()
        with patch.dict(
            "sys.modules",
            {
                "mlx": mlx,
                "mlx.core": mlx.core,
                "mlx_whisper": MagicMock(),
                "mlx_whisper.transcribe": transcribe,
            },
        ):
            backend = MLXWhisper("auto", model_dir="/models/mlx", device="cpu")

        transcribe.ModelHolder.get_model.assert_called_once_with(
            "/models/mlx", mlx.core.float16
        )
        self.assertIs(backend.model, transcribe.transcribe)
        self.assertIsNone(backend.original_language)

    def test_faster_whisper_retains_cpu_and_cuda_configuration(self):
        """The active backend must preserve device and compute-type selection."""
        for device, size, compute_type in [
            ("cpu", "tiny", "int8"),
            ("cuda", "small", "float16"),
        ]:
            with self.subTest(device=device):
                faster = MagicMock()
                with patch.dict("sys.modules", {"faster_whisper": faster}):
                    backend = FasterWhisperASR(
                        "en", model_dir="/models/whisper", device=device
                    )
                self.assertIs(backend.model, faster.WhisperModel.return_value)
                faster.WhisperModel.assert_called_once_with(
                    model_size_or_path=size,
                    device=device,
                    compute_type=compute_type,
                    local_files_only=False,
                    download_root="/models/whisper",
                )
