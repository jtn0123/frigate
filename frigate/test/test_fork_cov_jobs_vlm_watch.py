"""Coverage for the VLM watch job runner and singleton registry (fork D73)."""

import json
import logging
import threading
import unittest
from typing import Any
from unittest.mock import MagicMock, patch

import numpy as np

from frigate.jobs import vlm_watch as vw
from frigate.jobs.vlm_watch import (
    VLMWatchJob,
    VLMWatchRunner,
    get_vlm_watch_job,
    start_vlm_watch_job,
    stop_vlm_watch_job,
)
from frigate.types import JobStatusTypesEnum


class FakeClock:
    """Manual clock standing in for the time module."""

    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def time(self) -> float:
        return self.now


def _detection(camera: str, objects: list[dict[str, Any]] | None) -> tuple:
    return ("video", (camera, "frame", 0.0, objects, [], []))


class RunnerTestCase(unittest.TestCase):
    def setUp(self):
        self.requestor = MagicMock()
        self.subscriber = MagicMock()
        patch.object(vw, "InterProcessRequestor", return_value=self.requestor).start()
        patch.object(vw, "DetectionSubscriber", return_value=self.subscriber).start()
        self.clock = FakeClock()
        patch.object(vw, "time", self.clock).start()
        self.addCleanup(patch.stopall)

        self.chat_client = MagicMock(supports_vision=True)
        self.genai = MagicMock(chat_client=self.chat_client)
        self.frame_processor = MagicMock()
        self.frame_processor.get_current_frame.return_value = np.zeros(
            (240, 320, 3), dtype=np.uint8
        )
        self.dispatcher = MagicMock()

    def _runner(self, **job_kwargs: Any) -> VLMWatchRunner:
        job = VLMWatchJob(
            camera=job_kwargs.pop("camera", "front"),
            condition=job_kwargs.pop("condition", "a package arrives"),
            **job_kwargs,
        )
        runner = VLMWatchRunner(
            job=job,
            config=MagicMock(),
            cancel_event=threading.Event(),
            frame_processor=self.frame_processor,
            genai_manager=self.genai,
            dispatcher=self.dispatcher,
        )
        runner.conversation = [{"role": "system", "content": "sys"}]
        return runner

    def _reply(self, payload: Any) -> None:
        content = payload if isinstance(payload, str) else json.dumps(payload)
        self.chat_client.chat_with_tools.return_value = {"content": content}


class TestSystemPrompt(RunnerTestCase):
    def test_prompt_without_filters(self):
        prompt = self._runner()._build_system_prompt()
        self.assertIn('determine when "a package arrives" occurs', prompt)
        self.assertNotIn("Focus on", prompt)

    def test_prompt_with_labels_and_zones(self):
        prompt = self._runner(
            labels=["person", "car"], zones=["porch"]
        )._build_system_prompt()
        self.assertIn("Focus on object types: person, car and zones: porch.", prompt)

    def test_prompt_with_zones_only(self):
        prompt = self._runner(zones=["yard"])._build_system_prompt()
        self.assertIn("Focus on zones: yard.", prompt)


class TestDetectionFilters(RunnerTestCase):
    def test_no_filters_match_anything(self):
        self.assertTrue(self._runner()._detection_matches_filters([{"label": "x"}]))

    def test_label_and_zone_filters(self):
        runner = self._runner(labels=["person"], zones=["porch"])
        self.assertFalse(
            runner._detection_matches_filters(
                [{"label": "car", "current_zones": ["porch"]}]
            )
        )
        self.assertFalse(
            runner._detection_matches_filters(
                [{"label": "person", "current_zones": ["street"]}]
            )
        )
        self.assertFalse(runner._detection_matches_filters([{"label": "person"}]))
        self.assertTrue(
            runner._detection_matches_filters(
                [
                    {"label": "car", "current_zones": []},
                    {"label": "person", "current_zones": ["porch", "yard"]},
                ]
            )
        )


class TestRunIteration(RunnerTestCase):
    def test_no_chat_client_waits_30s(self):
        self.genai.chat_client = None
        runner = self._runner()
        with self.assertLogs(vw.logger, level=logging.WARNING):
            self.assertEqual(runner._run_iteration(), 30)
        self.frame_processor.get_current_frame.assert_not_called()

    def test_client_without_vision_waits_30s(self):
        self.chat_client.supports_vision = False
        with self.assertLogs(vw.logger, level=logging.WARNING):
            self.assertEqual(self._runner()._run_iteration(), 30)

    def test_missing_frame_waits_10s(self):
        self.frame_processor.get_current_frame.return_value = None
        runner = self._runner()
        self.assertEqual(runner._run_iteration(), 10)
        self.assertEqual(runner.job.last_reasoning, "Camera frame unavailable")
        self.frame_processor.get_current_frame.assert_called_once_with("front", {})
        self.chat_client.chat_with_tools.assert_not_called()

    def test_tall_frame_is_downscaled_to_480(self):
        self.frame_processor.get_current_frame.return_value = np.zeros(
            (960, 1280, 3), dtype=np.uint8
        )
        self._reply({"condition_met": False, "next_run_in": 5})
        runner = self._runner()
        with patch.object(vw.cv2, "resize", wraps=vw.cv2.resize) as resize:
            self.assertEqual(runner._run_iteration(), 5)
        self.assertEqual(resize.call_args.args[1], (640, 480))

    def test_small_frame_is_not_resized(self):
        self._reply({"condition_met": False, "next_run_in": 5})
        with patch.object(vw.cv2, "resize") as resize:
            self._runner()._run_iteration()
        resize.assert_not_called()

    def test_empty_response_drops_dangling_turn(self):
        self.chat_client.chat_with_tools.return_value = {"content": None}
        runner = self._runner()
        with self.assertLogs(vw.logger, level=logging.WARNING):
            self.assertEqual(runner._run_iteration(), 30)
        self.assertEqual(runner.conversation, [{"role": "system", "content": "sys"}])
        self.assertEqual(runner.job.iteration_count, 0)

    def test_user_turn_carries_jpeg_frame(self):
        self._reply({"condition_met": False})
        runner = self._runner()
        runner._run_iteration()
        kwargs = self.chat_client.chat_with_tools.call_args.kwargs
        self.assertIsNone(kwargs["tools"])
        self.assertIsNone(kwargs["tool_choice"])
        user = runner.conversation[1]
        self.assertEqual(user["role"], "user")
        self.assertTrue(
            user["content"][1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
        )
        self.assertEqual(runner.conversation[2]["role"], "assistant")

    def test_condition_not_met_clamps_interval(self):
        runner = self._runner()
        self._reply({"condition_met": False, "next_run_in": 1000, "reasoning": "r"})
        self.assertEqual(runner._run_iteration(), 300)
        self._reply({"condition_met": False, "next_run_in": 0})
        self.assertEqual(runner._run_iteration(), 1)
        self._reply({"condition_met": False})
        self.assertEqual(runner._run_iteration(), 30)
        self.assertEqual(runner.job.iteration_count, 3)
        self.assertEqual(runner.job.status, "queued")
        self.dispatcher.publish.assert_not_called()
        self.assertEqual(self.requestor.send_data.call_count, 3)

    def test_fenced_json_condition_met_notifies(self):
        self._reply(
            "```json\n"
            + json.dumps(
                {
                    "condition_met": True,
                    "reasoning": "box on porch",
                    "notification_message": "Package delivered",
                }
            )
            + "\n```"
        )
        runner = self._runner()
        self.assertEqual(runner._run_iteration(), 0)
        self.assertEqual(runner.job.status, JobStatusTypesEnum.success)
        self.assertEqual(runner.job.last_reasoning, "box on porch")
        topic, raw = self.dispatcher.publish.call_args.args
        self.assertEqual(topic, "camera_monitoring")
        self.assertEqual(
            json.loads(raw),
            {
                "camera": "front",
                "condition": "a package arrives",
                "message": "Package delivered",
                "reasoning": "box on porch",
                "job_id": runner.job.id,
            },
        )

    def test_condition_met_without_message_uses_reasoning(self):
        self._reply({"condition_met": True, "reasoning": "car parked"})
        runner = self._runner()
        runner._run_iteration()
        payload = json.loads(self.dispatcher.publish.call_args.args[1])
        self.assertEqual(payload["message"], "car parked")

    def test_unparseable_response_waits_30s(self):
        runner = self._runner()
        self._reply("not json at all")
        with self.assertLogs(vw.logger, level=logging.WARNING):
            self.assertEqual(runner._run_iteration(), 30)
        self._reply({"next_run_in": "soon"})
        with self.assertLogs(vw.logger, level=logging.WARNING):
            self.assertEqual(runner._run_iteration(), 30)
        self.assertEqual(runner.job.iteration_count, 0)

    def test_history_is_trimmed(self):
        runner = self._runner()
        for i in range(vw._MAX_HISTORY * 2 + 4):
            runner.conversation.append({"role": "user", "content": str(i)})
        self._reply({"condition_met": False})
        runner._run_iteration()
        self.assertEqual(len(runner.conversation), 1 + vw._MAX_HISTORY * 2)
        self.assertEqual(runner.conversation[0]["content"], "sys")
        self.assertEqual(runner.conversation[-1]["role"], "assistant")


class TestNotificationsAndBroadcast(RunnerTestCase):
    def test_no_dispatcher_is_a_noop(self):
        runner = self._runner()
        runner.dispatcher = None
        runner._send_notification("hi")

    def test_publish_failure_is_logged(self):
        self.dispatcher.publish.side_effect = RuntimeError("mqtt down")
        with self.assertLogs(vw.logger, level=logging.WARNING) as logs:
            self._runner()._send_notification("hi")
        self.assertIn("mqtt down", logs.output[0])

    def test_broadcast_failure_is_logged(self):
        self.requestor.send_data.side_effect = RuntimeError("ipc down")
        with self.assertLogs(vw.logger, level=logging.WARNING) as logs:
            self._runner()._broadcast_status()
        self.assertIn("ipc down", logs.output[0])

    def test_job_to_dict(self):
        d = VLMWatchJob(camera="c", labels=["person"]).to_dict()
        self.assertEqual(d["job_type"], "vlm_watch")
        self.assertEqual(d["labels"], ["person"])


class TestWaitForTrigger(RunnerTestCase):
    def _feed(self, runner: VLMWatchRunner, events: list[Any], step: float) -> None:
        """Return queued events per poll, advancing the fake clock each time."""
        queue = list(events)

        def _check(timeout: float) -> Any:
            self.clock.now += step
            return queue.pop(0) if queue else None

        self.subscriber.check_for_update.side_effect = _check

    def test_times_out_without_events(self):
        runner = self._runner(zones=["porch"])
        self._feed(runner, [], step=1.0)
        runner._wait_for_trigger(3)
        self.assertEqual(self.subscriber.check_for_update.call_count, 3)
        self.assertEqual(
            self.subscriber.check_for_update.call_args_list[0].kwargs, {"timeout": 1.0}
        )

    def test_zone_match_wakes_immediately(self):
        runner = self._runner(zones=["porch"])
        events = [
            (None, None),
            _detection("back", [{"label": "person", "current_zones": ["porch"]}]),
            _detection("front", []),
            _detection("front", [{"label": "person", "current_zones": ["yard"]}]),
            _detection("front", [{"label": "person", "current_zones": ["porch"]}]),
            _detection("front", [{"label": "person", "current_zones": ["porch"]}]),
        ]
        self._feed(runner, events, step=0.1)
        runner._wait_for_trigger(100)
        self.assertEqual(self.subscriber.check_for_update.call_count, 5)

    def test_without_zones_enforces_cooldown(self):
        runner = self._runner()
        events = [_detection("front", [{"label": "dog"}])] * 3
        self._feed(runner, events, step=2.0)
        runner._wait_for_trigger(100)
        # Matched at t+2; keeps draining until the 10 s cooldown passes.
        self.assertEqual(self.subscriber.check_for_update.call_count, 5)
        self.assertEqual(self.clock.now, 1010.0)

    def test_cancel_stops_waiting(self):
        runner = self._runner()
        runner.cancel_event.set()
        runner._wait_for_trigger(100)
        self.subscriber.check_for_update.assert_not_called()

    def test_short_wait_caps_poll_timeout(self):
        runner = self._runner()
        self._feed(runner, [], step=1.0)
        runner._wait_for_trigger(0.5)
        self.assertEqual(
            self.subscriber.check_for_update.call_args.kwargs, {"timeout": 0.5}
        )


class TestRunLoop(RunnerTestCase):
    def test_condition_met_ends_with_success(self):
        self._reply({"condition_met": True, "reasoning": "here"})
        runner = self._runner()
        runner.run()
        self.assertEqual(runner.job.status, JobStatusTypesEnum.success)
        self.assertEqual(runner.job.start_time, 1000.0)
        self.assertEqual(runner.job.end_time, 1000.0)
        self.assertIn("a package arrives", runner.conversation[0]["content"])
        statuses = [
            c.args[1]["status"] for c in self.requestor.send_data.call_args_list
        ]
        self.assertEqual(statuses[0], JobStatusTypesEnum.running)
        self.assertEqual(statuses[-1], JobStatusTypesEnum.success)
        self.subscriber.stop.assert_called_once()
        self.requestor.stop.assert_called_once()

    def test_times_out_after_max_duration(self):
        runner = self._runner(max_duration_minutes=1)
        self._reply({"condition_met": False, "next_run_in": 30})

        def _wait(seconds: float) -> None:
            self.clock.now += seconds

        with patch.object(runner, "_wait_for_trigger", side_effect=_wait):
            runner.run()
        self.assertEqual(runner.job.status, JobStatusTypesEnum.failed)
        self.assertEqual(runner.job.error_message, "Monitor timed out after 1 minutes")
        self.assertEqual(runner.job.iteration_count, 3)

    def test_iteration_exception_fails_job(self):
        self.chat_client.chat_with_tools.side_effect = RuntimeError("model gone")
        runner = self._runner()
        with self.assertLogs(vw.logger, level=logging.ERROR):
            runner.run()
        self.assertEqual(runner.job.status, JobStatusTypesEnum.failed)
        self.assertEqual(runner.job.error_message, "model gone")

    def test_cancelled_before_first_iteration(self):
        runner = self._runner()
        runner.cancel_event.set()
        self.subscriber.stop.side_effect = RuntimeError("sub")
        self.requestor.stop.side_effect = RuntimeError("req")
        runner.run()
        self.assertEqual(runner.job.status, JobStatusTypesEnum.cancelled)
        self.chat_client.chat_with_tools.assert_not_called()

    def test_cancel_after_wait_marks_cancelled(self):
        self._reply({"condition_met": False, "next_run_in": 5})
        runner = self._runner()
        with patch.object(
            runner,
            "_wait_for_trigger",
            side_effect=lambda _s: runner.cancel_event.set(),
        ):
            runner.run()
        self.assertEqual(runner.job.status, JobStatusTypesEnum.cancelled)
        self.assertEqual(runner.job.iteration_count, 1)


class TestJobRegistry(unittest.TestCase):
    def setUp(self):
        self._saved = (vw._current_job, vw._cancel_event)
        vw._current_job = None
        vw._cancel_event = None

    def tearDown(self):
        vw._current_job, vw._cancel_event = self._saved

    def _start(self, runner_cls: MagicMock, **kwargs: Any) -> str:
        with patch.object(vw, "VLMWatchRunner", runner_cls):
            return start_vlm_watch_job(
                camera="front",
                condition="dog on couch",
                max_duration_minutes=5,
                config=MagicMock(),
                frame_processor=MagicMock(),
                genai_manager=MagicMock(),
                dispatcher=MagicMock(),
                **kwargs,
            )

    def test_start_get_and_stop(self):
        self.assertIsNone(get_vlm_watch_job())
        self.assertFalse(stop_vlm_watch_job())

        runner_cls = MagicMock()
        job_id = self._start(
            runner_cls, labels=["dog"], zones=["living"], username="alice"
        )

        job = get_vlm_watch_job()
        self.assertEqual(job.id, job_id)
        self.assertEqual(
            (job.camera, job.labels, job.zones, job.username),
            ("front", ["dog"], ["living"], "alice"),
        )
        runner_cls.return_value.start.assert_called_once()
        cancel_event = runner_cls.call_args.kwargs["cancel_event"]

        with self.assertRaises(RuntimeError):
            self._start(MagicMock())

        self.assertTrue(stop_vlm_watch_job())
        self.assertTrue(cancel_event.is_set())
        self.assertEqual(job.status, JobStatusTypesEnum.cancelled)
        self.assertFalse(stop_vlm_watch_job())

    def test_new_job_allowed_after_previous_finished(self):
        self._start(MagicMock())
        get_vlm_watch_job().status = JobStatusTypesEnum.success
        new_id = self._start(MagicMock())
        self.assertEqual(get_vlm_watch_job().id, new_id)
        self.assertEqual(get_vlm_watch_job().labels, [])

    def test_stop_without_cancel_event(self):
        vw._current_job = VLMWatchJob(status=JobStatusTypesEnum.running)
        self.assertTrue(stop_vlm_watch_job())
        self.assertEqual(vw._current_job.status, JobStatusTypesEnum.cancelled)


if __name__ == "__main__":
    unittest.main()
