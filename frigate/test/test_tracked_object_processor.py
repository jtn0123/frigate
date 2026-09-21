"""Exercise the real detection-to-event pipeline without cameras or IPC sockets."""

import copy
import json
import queue
import tempfile
import threading
import unittest
from collections import deque
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np

from frigate.config import FrigateConfig
from frigate.const import UPDATE_CAMERA_ACTIVITY
from frigate.events.types import EventStateEnum
from frigate.track.object_processing import TrackedObjectProcessor

MODULE = "frigate.track.object_processing"


class TestTrackedObjectProcessor(unittest.TestCase):
    def setUp(self):
        self.config = FrigateConfig(
            **{
                "mqtt": {"enabled": False},
                "cameras": {
                    "front": {
                        "ffmpeg": {
                            "inputs": [
                                {
                                    "path": "rtsp://test/front",
                                    "roles": ["detect", "record"],
                                }
                            ]
                        },
                        "detect": {
                            "width": 320,
                            "height": 240,
                            "fps": 5,
                            "stationary": {"threshold": 2},
                        },
                        "objects": {
                            "track": ["person"],
                            "filters": {"person": {"threshold": 0.7}},
                        },
                        "mqtt": {"enabled": False},
                        "record": {"enabled": True},
                        "snapshots": {"enabled": True, "required_zones": ["entry"]},
                        "review": {
                            "alerts": {"required_zones": ["entry"]},
                            "detections": {"required_zones": ["entry"]},
                        },
                        "zones": {
                            "entry": {
                                "coordinates": "0.5,0,1,0,1,1,0.5,1",
                                "inertia": 2,
                            }
                        },
                    }
                },
            }
        )
        self.stop = threading.Event()
        self.frames = MagicMock()
        self.frames.get.return_value = np.zeros((360, 320), dtype=np.uint8)
        self.clients = {}
        for name in (
            "CameraConfigUpdateSubscriber",
            "InterProcessRequestor",
            "DetectionPublisher",
            "EventUpdatePublisher",
            "EventEndSubscriber",
            "EventMetadataSubscriber",
        ):
            self.clients[name] = self.enterContext(
                patch(f"{MODULE}.{name}")
            ).return_value
        self.enterContext(
            patch(f"{MODULE}.SharedMemoryFrameManager", return_value=self.frames)
        )
        self.clients["CameraConfigUpdateSubscriber"].check_for_updates.return_value = {}
        self.clients["EventEndSubscriber"].check_for_update.return_value = None
        self.clients["EventMetadataSubscriber"].check_for_update.return_value = None
        self.dispatcher = MagicMock()
        self.input_queue = MagicMock()
        self.processor = TrackedObjectProcessor(
            self.config, self.dispatcher, self.input_queue, MagicMock(), self.stop
        )
        self.events = []
        self.detections = []
        self.activity = []
        self.processor.event_sender.publish.side_effect = lambda payload: (
            self.events.append(copy.deepcopy(payload))
        )
        self.processor.detection_publisher.publish.side_effect = lambda payload, topic: (
            self.detections.append(copy.deepcopy(payload))
        )
        self.processor.requestor.send_data.side_effect = lambda topic, payload: (
            self.activity.append((topic, copy.deepcopy(payload)))
        )
        directory = self.enterContext(tempfile.TemporaryDirectory())
        for module in ("frigate.track.tracked_object", "frigate.camera.state"):
            self.enterContext(patch(f"{module}.THUMB_DIR", directory))
            self.enterContext(patch(f"{module}.CLIPS_DIR", directory))
        self.media_directory = Path(directory)

    def detection(self, when, *, inside=False, score=0.9, stationary=0, moves=1):
        box = (200, 20, 260, 100) if inside else (20, 20, 80, 100)
        return {
            "id": "100-person",
            "label": "person",
            "score": score,
            "score_history": [score] * 3,
            "box": box,
            "centroid": ((box[0] + box[2]) // 2, 60),
            "area": 4800,
            "ratio": 0.75,
            "region": (0, 0, 320, 240),
            "frame_time": float(when),
            "start_time": 100.0,
            "motionless_count": stationary,
            "position_changes": moves,
            "attributes": [],
        }

    def frame(self, when, detection=None, camera="front"):
        return (
            camera,
            f"{camera}-{when}",
            float(when),
            {detection["id"]: detection} if detection else {},
            [],
            [],
        )

    def run_frames(self, frames, changes=None):
        pending = deque(copy.deepcopy(frames))
        iteration = 0

        def config_updates():
            nonlocal iteration
            iteration += 1
            if changes and iteration in changes:
                return changes[iteration]()
            return {}

        def next_frame(*_args):
            if pending:
                return pending.popleft()
            self.stop.set()
            raise queue.Empty

        self.processor.camera_config_subscriber.check_for_updates.side_effect = (
            config_updates
        )
        self.input_queue.get.side_effect = next_frame
        self.processor.run()

    def mqtt_events(self):
        return [
            json.loads(call.args[1])
            for call in self.dispatcher.publish.call_args_list
            if call.args[0] == "events"
        ]

    def test_confirmed_object_starts_updates_and_ends_once(self):
        self.run_frames(
            [
                self.frame(100, self.detection(100)),
                self.frame(101, self.detection(101)),
                self.frame(102),
                self.frame(103),
            ]
        )
        self.assertEqual(
            [event[1] for event in self.events],
            [EventStateEnum.start, EventStateEnum.update, EventStateEnum.end],
        )
        self.assertEqual(
            [event["type"] for event in self.mqtt_events()], ["new", "end"]
        )
        ended = self.events[-1][-1]
        self.assertEqual(ended["end_time"], 102)
        self.assertFalse(ended["false_positive"])
        self.assertFalse(ended["has_clip"])
        self.assertFalse(ended["has_snapshot"])
        self.assertEqual(len(self.detections), 4)

    def test_end_acknowledgment_releases_tracked_object(self):
        def confirm_finished():
            self.processor.event_end_subscriber.check_for_update.side_effect = [
                ("100-person", "front", None),
                None,
            ]
            return {}

        self.run_frames(
            [
                self.frame(100, self.detection(100)),
                self.frame(101, self.detection(101)),
                self.frame(102),
                self.frame(103),
            ],
            {4: confirm_finished},
        )
        self.assertEqual(self.processor.camera_states["front"].tracked_objects, {})
        self.assertEqual(
            len([event for event in self.events if event[1] == EventStateEnum.end]), 1
        )

    def test_false_positive_never_becomes_public_or_retained(self):
        self.run_frames(
            [
                self.frame(100, self.detection(100, score=0.1)),
                self.frame(101, self.detection(101, score=0.1)),
                self.frame(102),
            ]
        )
        self.assertEqual(self.events[0][1], EventStateEnum.start)
        self.assertEqual(self.events[-1][1], EventStateEnum.end)
        self.assertTrue(self.events[-1][-1]["false_positive"])
        self.assertFalse(self.events[-1][-1]["has_clip"])
        self.assertFalse(self.events[-1][-1]["has_snapshot"])
        self.assertEqual(self.mqtt_events(), [])

    def test_zone_inertia_entry_exit_and_retained_media(self):
        self.run_frames(
            [
                self.frame(100, self.detection(100)),
                self.frame(101, self.detection(101)),
                self.frame(102, self.detection(102, inside=True)),
                self.frame(103, self.detection(103, inside=True)),
                self.frame(104, self.detection(104)),
                self.frame(105),
            ]
        )
        objects = [frame[3][0] for frame in self.detections]
        self.assertEqual(objects[2]["current_zones"], [])
        self.assertEqual(objects[3]["current_zones"], ["entry"])
        self.assertEqual(objects[4]["current_zones"], [])
        self.assertEqual(objects[4]["entered_zones"], ["entry"])
        self.assertFalse(objects[1]["has_clip"])
        ended = self.events[-1][-1]
        self.assertTrue(ended["has_clip"])
        self.assertTrue(ended["has_snapshot"])
        self.assertTrue((self.media_directory / "front/100-person.webp").is_file())
        self.assertTrue(
            (self.media_directory / "front-100-person-clean.webp").is_file()
        )

    def test_stationary_object_and_resumed_motion_are_published(self):
        self.run_frames(
            [
                self.frame(100, self.detection(100)),
                self.frame(101, self.detection(101)),
                self.frame(102, self.detection(102, stationary=3)),
                self.frame(103, self.detection(103, stationary=4)),
                self.frame(104, self.detection(104, moves=2)),
                self.frame(105, self.detection(105, moves=2)),
            ]
        )
        self.assertTrue(self.detections[3][3][0]["stationary"])
        self.assertFalse(self.detections[-1][3][0]["stationary"])
        activity_objects = [
            payload["front"]["objects"]
            for topic, payload in self.activity
            if topic == UPDATE_CAMERA_ACTIVITY and "front" in payload
        ]
        self.assertTrue(
            any(objects and objects[0]["stationary"] for objects in activity_objects)
        )
        self.assertFalse(activity_objects[-1][0]["stationary"])

    def test_disabling_camera_ends_event_once_and_skips_queued_frames(self):
        def disable():
            self.config.cameras["front"].enabled = False
            return {"enabled": ["front"]}

        self.run_frames(
            [
                self.frame(100, self.detection(100)),
                self.frame(101, self.detection(101)),
                self.frame(102, self.detection(102)),
                self.frame(103, self.detection(103)),
            ],
            {3: disable},
        )
        self.assertEqual(
            len([event for event in self.events if event[1] == EventStateEnum.end]), 1
        )
        self.assertEqual(len(self.detections), 2)
        self.assertEqual(
            self.processor.camera_activity["front"],
            {"enabled": False, "motion": 0, "objects": []},
        )

    def test_removal_drops_cached_state_and_ignores_stale_frames(self):
        def remove():
            self.config.cameras.pop("front")
            self.processor.last_motion_detected["front"] = 100
            return {"remove": ["front"]}

        self.run_frames(
            [
                self.frame(100, self.detection(100)),
                self.frame(101, self.detection(101)),
                self.frame(102, self.detection(102)),
            ],
            {3: remove},
        )
        self.assertNotIn("front", self.processor.camera_states)
        self.assertNotIn("front", self.processor.camera_activity)
        self.assertNotIn("front", self.processor.last_motion_detected)
        self.assertEqual(len(self.detections), 2)
        self.assertIn((UPDATE_CAMERA_ACTIVITY, {}), self.activity)

    def test_unknown_camera_is_ignored_and_clients_close(self):
        self.run_frames([self.frame(100, self.detection(100), camera="removed")])
        self.assertEqual(self.events, [])
        self.assertEqual(self.detections, [])
        for client in self.clients.values():
            client.stop.assert_called_once()

    def test_missing_shared_frame_still_emits_event_lifecycle(self):
        self.frames.get.return_value = None
        self.run_frames(
            [
                self.frame(100, self.detection(100)),
                self.frame(101, self.detection(101)),
                self.frame(102),
            ]
        )
        self.assertEqual(
            [event[1] for event in self.events],
            [EventStateEnum.start, EventStateEnum.update, EventStateEnum.end],
        )
        self.assertFalse(self.processor.camera_states["front"].frame_cache)
