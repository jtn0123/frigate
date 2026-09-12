"""Load ctranslate2 ahead of onnxruntime in the embeddings process."""

import importlib
import logging

from frigate.config import FrigateConfig

logger = logging.getLogger(__name__)


def transcription_enabled(config: FrigateConfig) -> bool:
    """Return True when a camera runs the recordings transcription post-processor.

    Mirrors the condition EmbeddingMaintainer uses to build
    AudioTranscriptionPostProcessor.
    """
    return any(
        camera.enabled_in_config and camera.audio_transcription.enabled
        for camera in config.cameras.values()
    )


def preload_transcription_runtime(config: FrigateConfig) -> bool:
    """Import ctranslate2 before any onnxruntime session exists in this process.

    With the ROCm build of onnxruntime (MIGraphX execution provider), loading
    ctranslate2 afterwards aborts the process with "free(): invalid pointer"
    when faster-whisper builds its model, so the embeddings process
    crash-looped whenever audio transcription was enabled. Importing it first
    avoids the conflict. It is only imported when transcription is enabled,
    like the post-processor, because the import can fail on CPUs without AVX.

    Args:
        config: The Frigate configuration.

    Returns:
        True if ctranslate2 was imported.
    """
    if not transcription_enabled(config):
        return False

    try:
        importlib.import_module("ctranslate2")
    except ImportError:
        logger.warning("ctranslate2 is unavailable, recordings will not be transcribed")
        return False

    return True
