"""ONVIF failures keep tracebacks without interpolating remote error text."""

import unittest
from unittest.mock import AsyncMock, MagicMock

from frigate.ptz.onvif import OnvifController, logger


class TestOnvifErrorLogging(unittest.IsolatedAsyncioTestCase):
    async def test_connection_failure_sanitizes_camera_name(self):
        camera_name = "front\r\nforged record"
        error = RuntimeError("remote\r\nforged message")
        controller = object.__new__(OnvifController)
        onvif = MagicMock()
        onvif.update_xaddrs = AsyncMock(side_effect=error)
        controller.cams = {camera_name: {"onvif": onvif}}

        with self.assertLogs(logger, "ERROR") as captured:
            result = await controller._init_onvif(camera_name)

        self.assertFalse(result)
        record = captured.records[0]
        self.assertEqual(
            record.getMessage(), "Onvif connection failed for front__forged record"
        )
        self.assertIs(record.exc_info[1], error)

    async def test_initialization_failure_sanitizes_log_but_retains_retry_error(self):
        camera_name = "front\r\nforged record"
        error = RuntimeError("remote\r\nforged message")
        controller = object.__new__(OnvifController)
        controller.config = MagicMock()
        controller.cams = {camera_name: {"init": False}}
        controller.failed_cams = {}
        controller.max_retries = 5
        controller.reset_timeout = 900
        controller._init_onvif = AsyncMock(side_effect=error)

        with self.assertLogs(logger, "ERROR") as captured:
            result = await controller.get_camera_info(camera_name)

        self.assertEqual(result, {})
        record = captured.records[0]
        self.assertEqual(
            record.getMessage(),
            "Error during ONVIF initialization for front__forged record",
        )
        self.assertIs(record.exc_info[1], error)
        self.assertEqual(controller.failed_cams[camera_name]["retry_attempts"], 1)
        self.assertEqual(controller.failed_cams[camera_name]["last_error"], str(error))
