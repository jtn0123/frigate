"""Sub label and plate edits find in-progress objects through a camera state
snapshot (D54).

An object that is still being tracked has no Event row yet, so the endpoints
look through the processor's camera states. They take a list copy so a camera
removed mid-iteration cannot break the loop."""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from peewee import DoesNotExist

from frigate.api import event as event_api
from frigate.api.defs.request.events_body import EventsLPRBody, EventsSubLabelBody
from frigate.comms.event_metadata_updater import EventMetadataTypeEnum


def _request(*tracked: dict) -> SimpleNamespace:
    processor = MagicMock()
    processor.get_camera_states.return_value = [
        SimpleNamespace(tracked_objects=objects) for objects in tracked
    ]
    return SimpleNamespace(
        app=SimpleNamespace(
            detected_frames_processor=processor,
            event_metadata_updater=MagicMock(),
        )
    )


class TestLiveObjectLabels(unittest.TestCase):
    def setUp(self):
        # no Event row exists for an object that is still being tracked
        patcher = patch.object(event_api.Event, "get", side_effect=DoesNotExist)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_sub_label_for_a_tracked_object(self):
        request = _request({}, {"obj1": object()})

        response = asyncio.run(
            event_api.set_sub_label(
                request, "obj1", EventsSubLabelBody(subLabel="Bob", subLabelScore=0.9)
            )
        )

        self.assertEqual(response.status_code, 200)
        request.app.detected_frames_processor.get_camera_states.assert_called_once()
        request.app.event_metadata_updater.publish.assert_called_once_with(
            ("obj1", "Bob", 0.9), EventMetadataTypeEnum.sub_label.value
        )

    def test_plate_for_a_tracked_object(self):
        request = _request({"obj1": object()})

        response = asyncio.run(
            event_api.set_plate(
                request, "obj1", EventsLPRBody(recognizedLicensePlate="")
            )
        )

        self.assertEqual(response.status_code, 200)
        # an empty plate clears the value and its score
        request.app.event_metadata_updater.publish.assert_called_once_with(
            ("obj1", "recognized_license_plate", None, None),
            EventMetadataTypeEnum.attribute.value,
        )

    def test_unknown_object_is_404(self):
        request = _request({"other": object()})

        sub_label = asyncio.run(
            event_api.set_sub_label(request, "obj1", EventsSubLabelBody(subLabel="x"))
        )
        plate = asyncio.run(
            event_api.set_plate(
                request, "obj1", EventsLPRBody(recognizedLicensePlate="ABC")
            )
        )

        self.assertEqual(sub_label.status_code, 404)
        self.assertEqual(plate.status_code, 404)
        request.app.event_metadata_updater.publish.assert_not_called()


if __name__ == "__main__":
    unittest.main()
