"""Behavior tests for the Dispatcher topic and camera command handlers (fork D67)."""

import datetime
import json
import logging
import os
import shutil
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from peewee_migrate import Router
from playhouse.sqlite_ext import SqliteExtDatabase

from frigate.comms.base_communicator import Communicator
from frigate.comms.dispatcher import Dispatcher
from frigate.comms.mqtt import MqttClient
from frigate.comms.webpush import WebPushClient
from frigate.config import FrigateConfig
from frigate.config.camera.updater import CameraConfigUpdateEnum
from frigate.const import (
    CLEAR_ONGOING_REVIEW_SEGMENTS,
    EXPIRE_AUDIO_ACTIVITY,
    INSERT_PREVIEW,
    NOTIFICATION_TEST,
    REQUEST_REGION_GRID,
    UPDATE_AUDIO_ACTIVITY,
    UPDATE_AUDIO_TRANSCRIPTION_STATE,
    UPDATE_BIRDSEYE_LAYOUT,
    UPDATE_CAMERA_ACTIVITY,
    UPDATE_EMBEDDINGS_REINDEX_PROGRESS,
    UPDATE_EVENT_DESCRIPTION,
    UPDATE_JOB_STATE,
    UPDATE_MODEL_STATE,
    UPDATE_NOTICE,
    UPDATE_REVIEW_DESCRIPTION,
    UPSERT_REVIEW_SEGMENT,
)
from frigate.models import Event, Previews, ReviewSegment
from frigate.ptz.onvif import OnvifCommandEnum
from frigate.types import ModelStatusTypesEnum


def _camera(roles: list[str], **extra) -> dict:
    camera = {
        "ffmpeg": {"inputs": [{"path": "rtsp://10.0.0.1:554/video", "roles": roles}]},
        "detect": {"height": 1080, "width": 1920, "fps": 5},
    }
    camera.update(extra)
    return camera


def _config() -> FrigateConfig:
    return FrigateConfig(
        **{
            "mqtt": {"host": "mqtt"},
            "objects": {"track": ["person", "dog"]},
            "cameras": {
                "front_door": _camera(
                    ["detect", "record", "audio"],
                    record={"enabled": True},
                    audio={"enabled": True},
                    motion={
                        "mask": {
                            "porch": {
                                "enabled": True,
                                "coordinates": "0,0,1,0,1,1",
                            },
                            "tree": {
                                "enabled": False,
                                "coordinates": "0,0,1,0,1,1",
                            },
                        }
                    },
                    objects={
                        "mask": {
                            "street": {
                                "enabled": True,
                                "coordinates": "0,0,1,1,0,1",
                            }
                        },
                        "filters": {
                            "dog": {
                                "mask": {
                                    "yard": {
                                        "enabled": False,
                                        "coordinates": "1,1,1,1,1,1",
                                    }
                                }
                            }
                        },
                    },
                    zones={
                        "driveway": {"coordinates": "0,0,1,0,1,1,0,1"},
                        "lawn": {"coordinates": "0,0,1,0,1,1,0,1", "enabled": False},
                    },
                ),
                "back_yard": _camera(["detect", "record"]),
            },
        }
    )


class _RecordingComm(Communicator):
    """Communicator that records every publish."""

    def __init__(self) -> None:
        self.messages: list[tuple[str, object, bool]] = []
        self.callback = None
        self.stopped = False

    def publish(self, topic, payload, retain=False) -> None:
        self.messages.append((topic, payload, retain))

    def subscribe(self, receiver) -> None:
        self.callback = receiver

    def stop(self) -> None:
        self.stopped = True


class DispatcherTestCase(unittest.TestCase):
    """Builds a dispatcher on a real config with mocked collaborators."""

    def setUp(self) -> None:
        self.config = _config()
        self.config_updater = MagicMock()
        self.onvif = MagicMock()
        self.comm = _RecordingComm()
        self.ptz_metrics = {"front_door": MagicMock()}

        with (
            patch("frigate.comms.dispatcher.CameraActivityManager") as cam_mgr,
            patch("frigate.comms.dispatcher.AudioActivityManager") as audio_mgr,
            patch("frigate.comms.dispatcher.RuntimeStatePersistence") as runtime,
        ):
            self.dispatcher = Dispatcher(
                self.config,
                self.config_updater,
                self.onvif,
                self.ptz_metrics,
                [self.comm],
            )
        self.camera_activity = cam_mgr.return_value
        self.audio_activity = audio_mgr.return_value
        self.runtime_state = runtime.return_value

    def published(self, topic: str) -> list[tuple[object, bool]]:
        return [(p, r) for t, p, r in self.comm.messages if t == topic]

    def update_enums(self) -> list[CameraConfigUpdateEnum]:
        return [
            c.args[0].update_type
            for c in self.config_updater.publish_update.call_args_list
        ]


class TestDispatcherWiring(DispatcherTestCase):
    def test_subscribes_to_every_communicator(self) -> None:
        self.assertEqual(self.comm.callback, self.dispatcher._receive)

    def test_unknown_topic_is_forwarded_to_communicators(self) -> None:
        self.dispatcher._receive("some/other/topic", "payload")
        self.assertEqual(self.published("some/other/topic"), [("payload", False)])

    def test_stop_stops_activity_and_communicators(self) -> None:
        self.dispatcher.stop()
        self.camera_activity.stop.assert_called_once()
        self.assertTrue(self.comm.stopped)

    def test_publish_local_skips_mqtt(self) -> None:
        mqtt = MagicMock(spec=MqttClient)
        self.dispatcher.comms.append(mqtt)
        self.dispatcher.publish_local("notices", "[]")
        mqtt.publish.assert_not_called()
        self.assertEqual(self.published("notices"), [("[]", False)])

    def test_publish_notices_without_registry_is_a_no_op(self) -> None:
        self.dispatcher._publish_notices()
        self.assertEqual(self.published("notices"), [])

    def test_web_push_client_gets_suspension_broadcaster(self) -> None:
        web_push = MagicMock(spec=WebPushClient)
        with (
            patch("frigate.comms.dispatcher.CameraActivityManager"),
            patch("frigate.comms.dispatcher.AudioActivityManager"),
            patch("frigate.comms.dispatcher.RuntimeStatePersistence"),
        ):
            dispatcher = Dispatcher(
                self.config, MagicMock(), MagicMock(), {}, [web_push]
            )
        self.assertIs(dispatcher.web_push_client, web_push)
        web_push.set_suspension_broadcaster.assert_called_once_with(dispatcher.publish)


class TestStateTopics(DispatcherTestCase):
    def test_model_state_update_and_request(self) -> None:
        self.dispatcher._receive(
            UPDATE_MODEL_STATE, {"model": "yolo", "state": "downloaded"}
        )
        self.assertEqual(
            self.dispatcher.model_state["yolo"], ModelStatusTypesEnum.downloaded
        )
        self.dispatcher._receive(UPDATE_MODEL_STATE, None)
        self.dispatcher._receive("modelState", None)
        states = self.published("model_state")
        self.assertEqual(len(states), 2)
        self.assertEqual(json.loads(states[-1][0]), {"yolo": "downloaded"})

    def test_job_state_update_ignores_missing_job_type(self) -> None:
        self.dispatcher._receive(UPDATE_JOB_STATE, {"status": "running"})
        self.dispatcher._receive(UPDATE_JOB_STATE, "not a dict")
        self.assertEqual(self.published("job_state"), [])

        job = {"job_type": "export", "status": "running"}
        self.dispatcher._receive(UPDATE_JOB_STATE, job)
        self.dispatcher._receive("jobState", None)
        states = self.published("job_state")
        self.assertEqual(len(states), 2)
        self.assertEqual(json.loads(states[-1][0]), {"export": job})

    def test_audio_transcription_state(self) -> None:
        self.dispatcher._receive(UPDATE_AUDIO_TRANSCRIPTION_STATE, "")
        self.assertEqual(self.dispatcher.audio_transcription_state, "idle")
        self.dispatcher._receive(UPDATE_AUDIO_TRANSCRIPTION_STATE, "processing")
        self.dispatcher._receive("audioTranscriptionState", None)
        states = self.published("audio_transcription_state")
        self.assertEqual([json.loads(p) for p, _ in states], ["processing"] * 2)

    def test_embeddings_reindex_progress(self) -> None:
        progress = {"status": "indexing", "processed": 4}
        self.dispatcher._receive(UPDATE_EMBEDDINGS_REINDEX_PROGRESS, progress)
        self.dispatcher._receive("embeddingsReindexProgress", None)
        states = self.published("embeddings_reindex_progress")
        self.assertEqual([json.loads(p) for p, _ in states], [progress, progress])

    def test_birdseye_layout(self) -> None:
        self.dispatcher._receive(UPDATE_BIRDSEYE_LAYOUT, None)
        self.assertEqual(self.published("birdseye_layout"), [])
        layout = {"front_door": {"x": 0, "y": 0}}
        self.dispatcher._receive(UPDATE_BIRDSEYE_LAYOUT, layout)
        self.dispatcher._receive("birdseyeLayout", None)
        states = self.published("birdseye_layout")
        self.assertEqual([json.loads(p) for p, _ in states], [layout, layout])

    def test_activity_topics_delegate_to_managers(self) -> None:
        self.dispatcher._receive(UPDATE_CAMERA_ACTIVITY, {"front_door": {}})
        self.dispatcher._receive(UPDATE_AUDIO_ACTIVITY, {"front_door": {}})
        self.dispatcher._receive(EXPIRE_AUDIO_ACTIVITY, "front_door")
        self.camera_activity.update_activity.assert_called_once_with({"front_door": {}})
        self.audio_activity.update_activity.assert_called_once_with({"front_door": {}})
        self.audio_activity.expire_all.assert_called_once_with("front_door")

    def test_notification_test(self) -> None:
        self.dispatcher._receive(NOTIFICATION_TEST, None)
        self.assertEqual(
            self.published("notification_test"), [("Test notification", False)]
        )

    def test_restart_calls_restart_frigate(self) -> None:
        with patch("frigate.comms.dispatcher.restart_frigate") as restart:
            self.dispatcher._receive("restart", None)
        restart.assert_called_once()

    def test_update_notice_without_registry_is_ignored(self) -> None:
        self.assertIsNone(self.dispatcher._receive(UPDATE_NOTICE, {"id": "x"}))

    def test_update_notice_swallows_registry_errors(self) -> None:
        registry = MagicMock()
        registry.apply.side_effect = RuntimeError("boom")
        self.dispatcher.notice_registry = registry
        self.dispatcher._receive(UPDATE_NOTICE, {"id": "x"})
        registry.apply.assert_called_once_with({"id": "x"})

    def test_region_grid_for_unknown_camera_is_none(self) -> None:
        self.assertIsNone(self.dispatcher._receive(REQUEST_REGION_GRID, "missing"))

    def test_region_grid_for_known_camera(self) -> None:
        with patch(
            "frigate.comms.dispatcher.get_camera_regions_grid",
            return_value=[[1]],
        ) as grid:
            result = self.dispatcher._receive(REQUEST_REGION_GRID, "front_door")
        self.assertEqual(result, [[1]])
        self.assertEqual(grid.call_args.args[0], "front_door")

    def test_on_connect_publishes_full_snapshot(self) -> None:
        self.camera_activity.last_camera_activity = {
            "front_door": {"motion": True},
            "removed_camera": {"motion": False},
        }
        self.audio_activity.current_audio_detections = {"front_door": ["bark"]}
        self.dispatcher.model_state = {"yolo": ModelStatusTypesEnum.downloaded}

        self.dispatcher._receive("onConnect", None)

        activity = json.loads(self.published("camera_activity")[0][0])
        self.assertEqual(set(activity), {"front_door", "back_yard"})
        self.assertTrue(activity["front_door"]["motion"])
        self.assertTrue(activity["front_door"]["config"]["record"])
        self.assertTrue(activity["front_door"]["config"]["audio"])
        self.assertFalse(activity["back_yard"]["config"]["record"])
        self.assertEqual(activity["back_yard"]["config"]["notifications_suspended"], 0)
        self.assertEqual(
            json.loads(self.published("audio_detections")[0][0]),
            {"front_door": ["bark"]},
        )
        self.assertEqual(self.published("profile/state"), [("none", True)])
        for topic in ("model_state", "embeddings_reindex_progress", "birdseye_layout"):
            self.assertEqual(len(self.published(topic)), 1, topic)

    def test_on_connect_reports_notification_suspension(self) -> None:
        web_push = MagicMock()
        web_push.suspended_cameras = {"front_door": 1234.9}
        self.dispatcher.web_push_client = web_push
        self.camera_activity.last_camera_activity = {}
        self.audio_activity.current_audio_detections = {}

        self.dispatcher._receive("onConnect", None)

        activity = json.loads(self.published("camera_activity")[0][0])
        self.assertEqual(
            activity["front_door"]["config"]["notifications_suspended"], 1234
        )
        self.assertEqual(activity["back_yard"]["config"]["notifications_suspended"], 0)


class TestDatabaseTopics(DispatcherTestCase):
    def setUp(self) -> None:
        super().setUp()
        # the migrations, not the models, make end_time and score nullable
        self.tmp_dir = tempfile.mkdtemp()
        db_path = os.path.join(self.tmp_dir, "frigate.db")
        migrate_db = SqliteExtDatabase(db_path)
        del logging.getLogger("peewee_migrate").handlers[:]
        Router(migrate_db).run()
        migrate_db.close()
        self.db = SqliteExtDatabase(db_path)
        self.db.bind([Event, Previews, ReviewSegment])

    def tearDown(self) -> None:
        self.db.close()
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def _review(self, id: str, end_time: float | None) -> dict:
        return {
            "id": id,
            "camera": "front_door",
            "start_time": 100.0,
            "end_time": end_time,
            "severity": "alert",
            "thumb_path": f"/thumb/{id}.webp",
            "data": {"objects": ["person"]},
        }

    def test_insert_preview(self) -> None:
        self.dispatcher._receive(
            INSERT_PREVIEW,
            {
                "id": "p1",
                "camera": "front_door",
                "path": "/preview/p1.mp4",
                "start_time": 1.0,
                "end_time": 2.0,
                "duration": 1.0,
            },
        )
        self.assertEqual(Previews.get_by_id("p1").path, "/preview/p1.mp4")

    def test_upsert_review_segment_inserts_then_updates(self) -> None:
        self.dispatcher._receive(UPSERT_REVIEW_SEGMENT, self._review("r1", None))
        self.assertIsNone(ReviewSegment.get_by_id("r1").end_time)

        self.dispatcher._receive(UPSERT_REVIEW_SEGMENT, self._review("r1", 200.0))
        self.assertEqual(ReviewSegment.select().count(), 1)
        self.assertEqual(ReviewSegment.get_by_id("r1").end_time, 200.0)

    def test_clear_ongoing_review_segments_only_touches_open_ones(self) -> None:
        ReviewSegment.insert(self._review("open", None)).execute()
        ReviewSegment.insert(self._review("done", 150.0)).execute()
        before = datetime.datetime.now().timestamp()

        self.dispatcher._receive(CLEAR_ONGOING_REVIEW_SEGMENTS, None)

        self.assertGreaterEqual(ReviewSegment.get_by_id("open").end_time, before)
        self.assertEqual(ReviewSegment.get_by_id("done").end_time, 150.0)

    def test_update_review_description_upserts_and_broadcasts(self) -> None:
        after = self._review("r2", 300.0)
        after["data"] = {"metadata": {"title": "Person at door"}}
        payload = {"type": "genai", "before": {}, "after": after}

        self.dispatcher._receive(UPDATE_REVIEW_DESCRIPTION, payload)

        self.assertEqual(
            ReviewSegment.get_by_id("r2").data["metadata"]["title"], "Person at door"
        )
        self.assertEqual(json.loads(self.published("reviews")[0][0]), payload)

    def test_update_event_description_saves_and_broadcasts(self) -> None:
        Event.insert(
            id="e1",
            label="person",
            camera="front_door",
            start_time=1.0,
            end_time=2.0,
            top_score=1,
            false_positive=False,
            zones=[],
            thumbnail="",
            has_clip=False,
            has_snapshot=False,
            region=[],
            box=[],
            area=0,
            data={"type": "object"},
        ).execute()

        with patch("frigate.comms.dispatcher.prefetch_for_event") as prefetch:
            self.dispatcher._receive(
                UPDATE_EVENT_DESCRIPTION, {"id": "e1", "description": "A courier"}
            )

        self.assertEqual(Event.get_by_id("e1").data["description"], "A courier")
        prefetch.assert_called_once()
        update = json.loads(self.published("tracked_object_update")[0][0])
        self.assertEqual(update["id"], "e1")
        self.assertEqual(update["description"], "A courier")
        self.assertEqual(update["camera"], "front_door")


class TestCameraCommandRouting(DispatcherTestCase):
    def test_unknown_camera_is_ignored(self) -> None:
        self.dispatcher._receive("missing/detect/set", "OFF")
        self.config_updater.publish_update.assert_not_called()

    def test_unknown_command_is_logged_not_raised(self) -> None:
        with self.assertLogs("frigate.comms.dispatcher", level="ERROR") as logs:
            self.dispatcher._receive("front_door/bogus/set", "ON")
        self.assertIn("Invalid command type", logs.output[0])

    def test_sub_command_required(self) -> None:
        with self.assertLogs("frigate.comms.dispatcher", level="ERROR") as logs:
            self.dispatcher._receive("front_door/zone/set", "ON")
        self.assertIn("requires a sub-command", logs.output[0])

    def test_global_notifications_command(self) -> None:
        self.dispatcher._receive("notifications/set", "ON")
        self.assertTrue(self.config.notifications.enabled)
        self.config_updater.publisher.publish.assert_called_once_with(
            "config/notifications", self.config.notifications
        )
        self.assertEqual(self.published("notifications/state"), [("ON", True)])

        self.dispatcher._receive("notifications/set", "MAYBE")
        self.assertEqual(len(self.published("notifications/state")), 1)

    def test_profile_command_without_manager(self) -> None:
        self.dispatcher._receive("profile/set", "away")
        self.assertEqual(self.published("profile/state"), [])

    def test_profile_command_activates_profile(self) -> None:
        manager = MagicMock()
        manager.activate_profile.return_value = None
        self.dispatcher.profile_manager = manager

        self.dispatcher._receive("profile/set", " away ")
        self.dispatcher._receive("profile/set", "none")

        self.assertEqual(
            [c.args[0] for c in manager.activate_profile.call_args_list],
            ["away", None],
        )
        self.assertEqual(
            self.published("profile/state"), [("away", True), ("none", True)]
        )

    def test_profile_command_error_does_not_publish(self) -> None:
        manager = MagicMock()
        manager.activate_profile.return_value = "unknown profile"
        self.dispatcher.profile_manager = manager
        self.dispatcher._receive("profile/set", "missing")
        self.assertEqual(self.published("profile/state"), [])

    def test_ptz_commands(self) -> None:
        self.dispatcher._receive("front_door/ptz", "preset_home")
        self.dispatcher._receive("front_door/ptz", b"MOVE_RELATIVE_0.1_0.2")
        self.dispatcher._receive("front_door/ptz", "stop")
        calls = [c.args for c in self.onvif.handle_command.call_args_list]
        self.assertEqual(
            calls,
            [
                ("front_door", OnvifCommandEnum.preset, "home"),
                ("front_door", OnvifCommandEnum.move_relative, "relative_0.1_0.2"),
                ("front_door", OnvifCommandEnum.stop, ""),
            ],
        )

    def test_invalid_ptz_command_is_logged(self) -> None:
        with self.assertLogs("frigate.comms.dispatcher", level="ERROR"):
            self.dispatcher._receive("front_door/ptz", "spin_around")
        self.onvif.handle_command.assert_not_called()

    def test_ptz_for_unknown_camera_is_ignored(self) -> None:
        self.dispatcher._receive("missing/ptz", "stop")
        self.onvif.handle_command.assert_not_called()


class TestToggleHandlers(DispatcherTestCase):
    def test_detect_on_turns_motion_on(self) -> None:
        camera = self.config.cameras["front_door"]
        camera.detect.enabled = False
        camera.motion.enabled = False

        self.dispatcher._receive("front_door/detect/set", "ON")

        self.assertTrue(camera.detect.enabled)
        self.assertTrue(camera.motion.enabled)
        self.assertEqual(
            self.update_enums(),
            [CameraConfigUpdateEnum.motion, CameraConfigUpdateEnum.detect],
        )
        self.assertEqual(self.published("front_door/motion/state"), [("ON", True)])
        self.runtime_state.set.assert_called_with("front_door", "detect", True)

    def test_detect_off(self) -> None:
        self.dispatcher._receive("front_door/detect/set", "OFF")
        self.assertFalse(self.config.cameras["front_door"].detect.enabled)
        self.assertEqual(self.published("front_door/detect/state"), [("OFF", True)])

    def test_enabled_toggle(self) -> None:
        camera = self.config.cameras["front_door"]
        self.dispatcher._receive("front_door/enabled/set", "OFF")
        self.assertFalse(camera.enabled)
        self.dispatcher._receive("front_door/enabled/set", "ON")
        self.assertTrue(camera.enabled)

        camera.enabled_in_config = False
        camera.enabled = False
        self.dispatcher._receive("front_door/enabled/set", "ON")
        self.assertFalse(camera.enabled)
        self.assertEqual(len(self.published("front_door/enabled/state")), 2)

    def test_motion_off_blocked_while_detecting(self) -> None:
        camera = self.config.cameras["front_door"]
        camera.detect.enabled = True
        self.dispatcher._receive("front_door/motion/set", "OFF")
        self.assertTrue(camera.motion.enabled)
        self.assertEqual(self.published("front_door/motion/state"), [])

        camera.detect.enabled = False
        self.dispatcher._receive("front_door/motion/set", "OFF")
        self.assertFalse(camera.motion.enabled)
        self.dispatcher._receive("front_door/motion/set", "ON")
        self.assertTrue(camera.motion.enabled)
        self.assertEqual(
            self.published("front_door/motion/state"), [("OFF", True), ("ON", True)]
        )

    def test_improve_contrast(self) -> None:
        motion = self.config.cameras["front_door"].motion
        motion.improve_contrast = False
        self.dispatcher._receive("front_door/improve_contrast/set", "ON")
        self.assertTrue(motion.improve_contrast)
        self.dispatcher._receive("front_door/improve_contrast/set", "OFF")
        self.assertFalse(motion.improve_contrast)
        self.assertEqual(len(self.published("front_door/improve_contrast/state")), 2)

    def test_motion_contour_area_and_threshold(self) -> None:
        motion = self.config.cameras["front_door"].motion
        self.dispatcher._receive("front_door/motion_contour_area/set", "42")
        self.dispatcher._receive("front_door/motion_threshold/set", "33")
        self.assertEqual(motion.contour_area, 42)
        self.assertEqual(motion.threshold, 33)
        self.assertEqual(
            self.published("front_door/motion_contour_area/state"), [(42, True)]
        )
        self.assertEqual(
            self.published("front_door/motion_threshold/state"), [(33, True)]
        )

    def test_motion_numeric_commands_reject_non_integers(self) -> None:
        motion = self.config.cameras["front_door"].motion
        before = (motion.contour_area, motion.threshold)
        self.dispatcher._receive("front_door/motion_contour_area/set", "big")
        self.dispatcher._receive("front_door/motion_threshold/set", "high")
        self.assertEqual((motion.contour_area, motion.threshold), before)
        self.config_updater.publish_update.assert_not_called()

    def test_ptz_autotracker(self) -> None:
        camera = self.config.cameras["front_door"]
        metrics = self.ptz_metrics["front_door"]

        camera.onvif.autotracking.enabled_in_config = False
        self.dispatcher._receive("front_door/ptz_autotracker/set", "ON")
        self.assertEqual(self.published("front_door/ptz_autotracker/state"), [])

        camera.onvif.autotracking.enabled_in_config = True
        metrics.autotracker_enabled.value = False
        self.dispatcher._receive("front_door/ptz_autotracker/set", "ON")
        self.assertTrue(metrics.autotracker_enabled.value)
        self.assertTrue(camera.onvif.autotracking.enabled)

        self.dispatcher._receive("front_door/ptz_autotracker/set", "OFF")
        self.assertFalse(metrics.autotracker_enabled.value)
        self.assertFalse(camera.onvif.autotracking.enabled)
        self.assertEqual(self.update_enums(), [CameraConfigUpdateEnum.autotracking] * 2)

    def test_audio_toggle_and_gate(self) -> None:
        audio = self.config.cameras["front_door"].audio
        self.dispatcher._receive("front_door/audio/set", "OFF")
        self.assertFalse(audio.enabled)
        self.dispatcher._receive("front_door/audio/set", "ON")
        self.assertTrue(audio.enabled)

        self.dispatcher._receive("back_yard/audio/set", "ON")
        self.assertFalse(self.config.cameras["back_yard"].audio.enabled)
        self.assertEqual(self.published("back_yard/audio/state"), [])

    def test_audio_transcription_toggle_and_gate(self) -> None:
        transcription = self.config.cameras["front_door"].audio_transcription
        self.dispatcher._receive("front_door/audio_transcription/set", "ON")
        self.assertEqual(self.published("front_door/audio_transcription/state"), [])

        transcription.enabled_in_config = True
        self.dispatcher._receive("front_door/audio_transcription/set", "ON")
        self.assertTrue(transcription.live_enabled)
        self.dispatcher._receive("front_door/audio_transcription/set", "OFF")
        self.assertFalse(transcription.live_enabled)
        self.assertEqual(
            self.update_enums(), [CameraConfigUpdateEnum.audio_transcription] * 2
        )

    def test_recordings_toggle_and_gate(self) -> None:
        record = self.config.cameras["front_door"].record
        self.dispatcher._receive("front_door/recordings/set", "OFF")
        self.assertFalse(record.enabled)
        self.dispatcher._receive("front_door/recordings/set", "ON")
        self.assertTrue(record.enabled)
        self.runtime_state.set.assert_called_with("front_door", "recordings", True)

        self.dispatcher._receive("back_yard/recordings/set", "ON")
        self.assertFalse(self.config.cameras["back_yard"].record.enabled)

    def test_snapshots_toggle(self) -> None:
        snapshots = self.config.cameras["front_door"].snapshots
        snapshots.enabled = False
        self.dispatcher._receive("front_door/snapshots/set", "ON")
        self.assertTrue(snapshots.enabled)
        self.dispatcher._receive("front_door/snapshots/set", "OFF")
        self.assertFalse(snapshots.enabled)
        self.assertEqual(
            self.published("front_door/snapshots/state"),
            [("ON", True), ("OFF", True)],
        )

    def test_birdseye_toggle(self) -> None:
        birdseye = self.config.cameras["front_door"].birdseye
        self.dispatcher._receive("front_door/birdseye/set", "OFF")
        self.assertFalse(birdseye.enabled)
        self.dispatcher._receive("front_door/birdseye/set", "ON")
        self.assertTrue(birdseye.enabled)
        self.assertEqual(self.update_enums(), [CameraConfigUpdateEnum.birdseye] * 2)

    def test_birdseye_modes_rejected_when_birdseye_off(self) -> None:
        self.config.cameras["front_door"].birdseye.enabled = False
        self.dispatcher._receive("front_door/birdseye_modes/set", "MOTION")
        self.config_updater.publish_update.assert_not_called()

    def test_review_alert_and_detection_toggles(self) -> None:
        review = self.config.cameras["front_door"].review
        self.dispatcher._receive("front_door/review_alerts/set", "OFF")
        self.dispatcher._receive("front_door/review_detections/set", "OFF")
        self.assertFalse(review.alerts.enabled)
        self.assertFalse(review.detections.enabled)

        self.dispatcher._receive("front_door/review_alerts/set", "ON")
        self.dispatcher._receive("front_door/review_detections/set", "ON")
        self.assertTrue(review.alerts.enabled)
        self.assertTrue(review.detections.enabled)

        review.alerts.enabled_in_config = False
        review.detections.enabled_in_config = False
        review.alerts.enabled = False
        review.detections.enabled = False
        self.dispatcher._receive("front_door/review_alerts/set", "ON")
        self.dispatcher._receive("front_door/review_detections/set", "ON")
        self.assertFalse(review.alerts.enabled)
        self.assertFalse(review.detections.enabled)
        self.assertEqual(self.update_enums(), [CameraConfigUpdateEnum.review] * 4)

    def test_genai_description_toggles(self) -> None:
        camera = self.config.cameras["front_door"]
        self.dispatcher._receive("front_door/object_descriptions/set", "ON")
        self.dispatcher._receive("front_door/review_descriptions/set", "ON")
        self.assertFalse(camera.objects.genai.enabled)
        self.assertFalse(camera.review.genai.enabled)

        camera.objects.genai.enabled_in_config = True
        camera.review.genai.enabled_in_config = True
        self.dispatcher._receive("front_door/object_descriptions/set", "ON")
        self.dispatcher._receive("front_door/review_descriptions/set", "ON")
        self.assertTrue(camera.objects.genai.enabled)
        self.assertTrue(camera.review.genai.enabled)

        self.dispatcher._receive("front_door/object_descriptions/set", "OFF")
        self.dispatcher._receive("front_door/review_descriptions/set", "OFF")
        self.assertFalse(camera.objects.genai.enabled)
        self.assertFalse(camera.review.genai.enabled)
        self.assertEqual(
            self.update_enums(),
            [
                CameraConfigUpdateEnum.object_genai,
                CameraConfigUpdateEnum.review_genai,
            ]
            * 2,
        )


class TestNotificationHandlers(DispatcherTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.notifications = self.config.cameras["front_door"].notifications
        self.web_push = MagicMock()
        self.web_push.suspended_cameras = {"front_door": 999}
        self.dispatcher.web_push_client = self.web_push

    def test_on_requires_enabled_in_config(self) -> None:
        self.notifications.enabled_in_config = False
        self.dispatcher._receive("front_door/notifications/set", "ON")
        self.assertEqual(self.published("front_door/notifications/state"), [])

    def test_on_and_off_clear_suspension(self) -> None:
        self.notifications.enabled_in_config = True
        self.dispatcher._receive("front_door/notifications/set", "ON")
        self.assertTrue(self.notifications.enabled)
        self.assertEqual(self.web_push.suspended_cameras["front_door"], 0)

        self.web_push.suspended_cameras["front_door"] = 5
        self.dispatcher._receive("front_door/notifications/set", "OFF")
        self.assertFalse(self.notifications.enabled)
        self.assertEqual(self.web_push.suspended_cameras["front_door"], 0)
        self.assertEqual(
            self.published("front_door/notifications/suspended"),
            [("0", True), ("0", True)],
        )

    def test_suspend_invalid_duration(self) -> None:
        self.dispatcher._receive("front_door/notifications/suspend", "soon")
        self.web_push.suspend_notifications.assert_not_called()

    def test_suspend_without_web_push(self) -> None:
        self.dispatcher.web_push_client = None
        self.notifications.enabled = True
        self.dispatcher._receive("front_door/notifications/suspend", "10")
        self.assertEqual(self.published("front_door/notifications/suspended"), [])

    def test_suspend_requires_notifications_enabled(self) -> None:
        self.notifications.enabled = False
        self.dispatcher._receive("front_door/notifications/suspend", "10")
        self.web_push.suspend_notifications.assert_not_called()

    def test_suspend_and_unsuspend(self) -> None:
        self.notifications.enabled = True
        self.dispatcher._receive("front_door/notifications/suspend", "10")
        self.web_push.suspend_notifications.assert_called_once_with("front_door", 10)
        self.dispatcher._receive("front_door/notifications/suspend", "0")
        self.web_push.unsuspend_notifications.assert_called_once_with("front_door")
        self.assertEqual(
            self.published("front_door/notifications/suspended"),
            [("999", True), ("999", True)],
        )

    def test_suspend_unknown_camera_is_ignored(self) -> None:
        self.dispatcher._receive("missing/notifications/suspend", "10")
        self.web_push.suspend_notifications.assert_not_called()


class TestMaskAndZoneHandlers(DispatcherTestCase):
    def test_motion_mask_toggle(self) -> None:
        self.dispatcher._receive("front_door/motion_mask/porch/set", "OFF")
        motion = self.config.cameras["front_door"].motion
        self.assertFalse(motion.mask["porch"].enabled)
        self.assertEqual(self.update_enums(), [CameraConfigUpdateEnum.motion])
        self.assertEqual(
            self.published("front_door/motion_mask/porch/state"), [("OFF", True)]
        )

        self.dispatcher._receive("front_door/motion_mask/porch/set", "ON")
        motion = self.config.cameras["front_door"].motion
        self.assertTrue(motion.mask["porch"].enabled)

    def test_motion_mask_rejections(self) -> None:
        self.dispatcher._receive("front_door/motion_mask/porch/set", "MAYBE")
        self.dispatcher._receive("front_door/motion_mask/missing/set", "OFF")
        self.dispatcher._receive("front_door/motion_mask/tree/set", "ON")
        self.config_updater.publish_update.assert_not_called()

    def test_object_mask_global_toggle(self) -> None:
        self.dispatcher._receive("front_door/object_mask/street/set", "OFF")
        objects = self.config.cameras["front_door"].objects
        self.assertFalse(objects.mask["street"].enabled)
        self.assertEqual(self.update_enums(), [CameraConfigUpdateEnum.objects])
        self.assertEqual(
            self.published("front_door/object_mask/street/state"), [("OFF", True)]
        )

    def test_object_mask_filter_toggle(self) -> None:
        self.dispatcher._receive("front_door/object_mask/yard/set", "OFF")
        objects = self.config.cameras["front_door"].objects
        self.assertFalse(objects.filters["dog"].mask["yard"].enabled)
        self.assertEqual(
            self.published("front_door/object_mask/yard/state"), [("OFF", True)]
        )

    def test_object_mask_rejections(self) -> None:
        self.dispatcher._receive("front_door/object_mask/street/set", "MAYBE")
        self.dispatcher._receive("front_door/object_mask/missing/set", "OFF")
        self.dispatcher._receive("front_door/object_mask/yard/set", "ON")
        self.config_updater.publish_update.assert_not_called()

    def test_object_mask_global_on_requires_enabled_in_config(self) -> None:
        self.config.cameras["front_door"].objects.mask[
            "street"
        ].enabled_in_config = False
        self.dispatcher._receive("front_door/object_mask/street/set", "ON")
        self.config_updater.publish_update.assert_not_called()

    def test_zone_toggle(self) -> None:
        zones = self.config.cameras["front_door"].zones
        self.dispatcher._receive("front_door/zone/driveway/set", "OFF")
        self.assertFalse(zones["driveway"].enabled)
        self.dispatcher._receive("front_door/zone/driveway/set", "ON")
        self.assertTrue(zones["driveway"].enabled)
        self.assertEqual(self.update_enums(), [CameraConfigUpdateEnum.zones] * 2)
        self.assertEqual(
            self.published("front_door/zone/driveway/state"),
            [("OFF", True), ("ON", True)],
        )

    def test_zone_rejections(self) -> None:
        self.dispatcher._receive("front_door/zone/driveway/set", "MAYBE")
        self.dispatcher._receive("front_door/zone/missing/set", "OFF")
        self.dispatcher._receive("front_door/zone/lawn/set", "ON")
        self.config_updater.publish_update.assert_not_called()


if __name__ == "__main__":
    unittest.main()
