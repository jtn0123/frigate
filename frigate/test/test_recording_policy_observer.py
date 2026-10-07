"""Recording expectation follows immediate camera and recording toggles."""

import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from frigate.comms.dispatcher import Dispatcher


class TestRecordingPolicyObserver(unittest.TestCase):
    def test_fast_toggles_are_observed_before_the_next_stats_sample(self):
        dispatcher = Dispatcher.__new__(Dispatcher)
        camera = SimpleNamespace(record=SimpleNamespace(enabled=True))
        dispatcher.config = SimpleNamespace(cameras={"doorbell": camera})
        communicator = Mock()
        dispatcher.comms = [communicator]
        observed = []
        dispatcher.recording_policy_changed = lambda config: observed.append(
            config.cameras["doorbell"].record.enabled
        )

        camera.record.enabled = False
        dispatcher.publish("doorbell/recordings/state", "OFF", retain=True)
        camera.record.enabled = True
        dispatcher.publish("doorbell/recordings/state", "ON", retain=True)

        self.assertEqual(observed, [False, True])
        self.assertEqual(communicator.publish.call_count, 2)

    def test_camera_toggle_is_observed_but_detection_state_is_not(self):
        dispatcher = Dispatcher.__new__(Dispatcher)
        dispatcher.config = Mock()
        dispatcher.comms = []
        dispatcher.recording_policy_changed = Mock()

        dispatcher.publish("doorbell/detect/state", "OFF")
        dispatcher.recording_policy_changed.assert_not_called()
        dispatcher.publish("doorbell/enabled/state", "OFF")
        dispatcher.recording_policy_changed.assert_called_once_with(dispatcher.config)
