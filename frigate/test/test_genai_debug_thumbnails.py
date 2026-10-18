"""GenAI debug thumbnails must be saved for early object description requests."""

import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

# Mock TFLite before importing the maintainer
_MOCK_MODULES = [
    "tflite_runtime",
    "tflite_runtime.interpreter",
    "ai_edge_litert",
    "ai_edge_litert.interpreter",
]
for mod in _MOCK_MODULES:
    if mod not in sys.modules:
        sys.modules[mod] = MagicMock()

# imported from the maintainer to avoid tripping the circular import between
# the maintainer and the processor modules
from frigate.embeddings.maintainer import (  # noqa: E402
    ObjectDescriptionProcessor,
    PostProcessDataEnum,
)

MODULE = "frigate.data_processing.post.object_descriptions"
EVENT_ID = "1234.5-abcdef"


class TestEarlyRequestDebugThumbnails(unittest.TestCase):
    def setUp(self) -> None:
        self.clips_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.clips_dir)

    def _make_processor(self, debug_save: bool) -> ObjectDescriptionProcessor:
        config = MagicMock()
        camera = MagicMock()
        genai = camera.objects.genai
        genai.enabled = True
        genai.send_triggers.after_significant_updates = 1
        genai.objects = []
        genai.required_zones = []
        genai.debug_save_thumbnails = debug_save
        config.cameras = {"front": camera}

        genai_manager = MagicMock()
        genai_manager.description_client = MagicMock()

        return ObjectDescriptionProcessor(
            config, None, MagicMock(), MagicMock(), genai_manager, None
        )

    def _update(self, processor: ObjectDescriptionProcessor) -> None:
        event = MagicMock()
        event.id = EVENT_ID
        event.label = "person"

        with (
            patch(f"{MODULE}.CLIPS_DIR", self.clips_dir),
            patch(f"{MODULE}.create_thumbnail", return_value=b"jpeg-bytes"),
            patch(f"{MODULE}.Event.get", return_value=event),
            patch(f"{MODULE}.threading.Thread") as thread,
        ):
            processor.process_data(
                {
                    "camera": "front",
                    "data": {
                        "id": EVENT_ID,
                        "box": (0, 0, 10, 10),
                        "stationary": False,
                        "has_clip": True,
                        "has_snapshot": True,
                        "entered_zones": [],
                    },
                    "state": "update",
                    "yuv_frame": MagicMock(),
                },
                PostProcessDataEnum.tracked_object,
            )

        # the early request itself was sent
        thread.assert_called_once()

    def _saved_path(self) -> str:
        return os.path.join(self.clips_dir, "genai-requests", EVENT_ID, "1.jpg")

    def test_early_request_saves_debug_thumbnails(self):
        processor = self._make_processor(debug_save=True)
        self._update(processor)

        with open(self._saved_path(), "rb") as f:
            self.assertEqual(f.read(), b"jpeg-bytes")

    def test_early_request_skips_thumbnails_when_debug_disabled(self):
        processor = self._make_processor(debug_save=False)
        self._update(processor)

        self.assertFalse(os.path.exists(self._saved_path()))


if __name__ == "__main__":
    unittest.main()
