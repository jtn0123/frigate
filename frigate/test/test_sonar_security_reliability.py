"""Regression tests for camera request boundaries, logs, and GPU shutdown."""

import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from frigate.api import camera, classification
from frigate.comms.dispatcher import Dispatcher
from frigate.jobs import motion_search
from frigate.ptz.onvif import OnvifController
from frigate.util import services


class TestCameraLogInjection(unittest.TestCase):
    def test_rejected_stream_name_cannot_create_log_lines(self):
        with self.assertLogs(camera.logger, "WARNING") as logs:
            result = camera.go2rtc_add_stream(
                MagicMock(), "front\r\nforged", "exec:bad"
            )
        self.assertEqual(result.status_code, 400)
        self.assertNotIn("\r", logs.records[0].getMessage())
        self.assertNotIn("\n", logs.records[0].getMessage())
        self.assertIn("front", logs.records[0].getMessage())

    def test_stream_failures_escape_name_and_remote_response(self):
        response = MagicMock(ok=False, status_code=502, text="remote\r\nforged")
        for operation in ["add", "delete"]:
            with self.subTest(operation=operation):
                with (
                    patch.object(camera.requests, "put", return_value=response),
                    patch.object(camera.requests, "delete", return_value=response),
                    self.assertLogs(camera.logger, "ERROR") as logs,
                ):
                    if operation == "add":
                        result = camera.go2rtc_add_stream(
                            MagicMock(), "front\r\nforged"
                        )
                    else:
                        result = camera.go2rtc_delete_stream("front\r\nforged")
                self.assertEqual(result.status_code, 502)
                self.assertNotIn("\r", logs.records[0].getMessage())
                self.assertNotIn("\n", logs.records[0].getMessage())
                self.assertIn("remote", logs.records[0].getMessage())


class TestOnvifLogInjection(unittest.IsolatedAsyncioTestCase):
    async def test_unknown_camera_name_cannot_create_log_lines(self):
        controller = object.__new__(OnvifController)
        controller.camera_configs = {}
        with self.assertLogs("frigate.ptz.onvif", "ERROR") as logs:
            result = await controller._init_single_camera("front\r\nforged")
        self.assertFalse(result)
        self.assertNotIn("\r", logs.records[0].getMessage())
        self.assertNotIn("\n", logs.records[0].getMessage())

    async def test_remote_capability_error_cannot_create_log_lines(self):
        controller = object.__new__(OnvifController)
        onvif = MagicMock()
        onvif.update_xaddrs = AsyncMock()
        onvif.create_media_service = AsyncMock()
        onvif.get_definition.side_effect = RuntimeError("remote\r\nforged")
        controller.cams = {"front": {"onvif": onvif}}
        with self.assertLogs("frigate.ptz.onvif", "ERROR") as logs:
            result = await controller._init_onvif("front")
        self.assertFalse(result)
        self.assertNotIn("\r", logs.records[0].getMessage())
        self.assertNotIn("\n", logs.records[0].getMessage())
        self.assertIn("remote", logs.records[0].getMessage())

    async def test_custom_error_representation_cannot_forge_log_lines(self):
        class RemoteError(RuntimeError):
            def __repr__(self):
                return "remote\r\nforged"

        controller = object.__new__(OnvifController)
        onvif = MagicMock()
        onvif.update_xaddrs = AsyncMock()
        onvif.create_media_service = AsyncMock()
        onvif.get_definition.side_effect = RemoteError()
        controller.cams = {"front": {"onvif": onvif}}
        with self.assertLogs("frigate.ptz.onvif", "ERROR") as logs:
            result = await controller._init_onvif("front")
        self.assertFalse(result)
        self.assertNotIn("\r", logs.records[0].getMessage())
        self.assertNotIn("\n", logs.records[0].getMessage())


class TestGpuShutdown(unittest.TestCase):
    def test_gpu_helpers_do_not_swallow_shutdown(self):
        for helper in [services.get_nvidia_gpu_stats, services.get_nvidia_driver_info]:
            for error in [KeyboardInterrupt, SystemExit]:
                with self.subTest(helper=helper.__name__, error=error):
                    with patch.object(services.nvml, "nvmlInit", side_effect=error):
                        with self.assertRaises(error):
                            helper()

    def test_unavailable_gpu_still_returns_empty_stats(self):
        for helper in [services.get_nvidia_gpu_stats, services.get_nvidia_driver_info]:
            with self.subTest(helper=helper.__name__):
                with patch.object(services.nvml, "nvmlInit", side_effect=RuntimeError):
                    self.assertEqual(helper(), {})


class TestOtherLogInjection(unittest.TestCase):
    def test_classification_deletion_escapes_original_model_name(self):
        with (
            patch.object(classification.os.path, "exists", return_value=True),
            patch.object(classification.shutil, "rmtree") as delete,
            self.assertLogs(classification.logger, "INFO") as logs,
        ):
            result = classification.delete_classification_model(
                MagicMock(), "model\r\nforged"
            )
        self.assertEqual(result.status_code, 200)
        self.assertEqual(delete.call_count, 2)
        self.assertEqual(len(logs.records), 2)
        for record in logs.records:
            self.assertNotIn("\r", record.getMessage())
            self.assertNotIn("\n", record.getMessage())

    def test_motion_cancellation_escapes_job_id_and_broadcast_failure(self):
        job_id = "job\r\nforged"
        job = MagicMock(status=motion_search.JobStatusTypesEnum.running)
        cancel = MagicMock()
        requestor = MagicMock()
        requestor.send_data.side_effect = RuntimeError("remote\r\nforged")
        with (
            patch.dict(motion_search._motion_search_jobs, {job_id: (job, cancel)}),
            patch.object(
                motion_search, "InterProcessRequestor", return_value=requestor
            ),
            self.assertLogs(motion_search.logger, "INFO") as logs,
        ):
            self.assertTrue(motion_search.cancel_motion_search_job(job_id))
        cancel.set.assert_called_once_with()
        requestor.stop.assert_called_once_with()
        self.assertEqual(job.status, motion_search.JobStatusTypesEnum.cancelled)
        self.assertEqual(len(logs.records), 2)
        for record in logs.records:
            self.assertNotIn("\r", record.getMessage())
            self.assertNotIn("\n", record.getMessage())

    def test_dispatcher_escapes_invalid_command_topic(self):
        dispatcher = object.__new__(Dispatcher)
        handler = MagicMock(side_effect=IndexError)
        dispatcher._global_settings_handlers = {"bad\r\nforged": handler}
        with self.assertLogs("frigate.comms.dispatcher", "ERROR") as logs:
            self.assertIsNone(dispatcher._receive("bad\r\nforged/set", "bad payload"))
        handler.assert_called_once_with("bad payload")
        self.assertNotIn("\r", logs.records[0].getMessage())
        self.assertNotIn("\n", logs.records[0].getMessage())
