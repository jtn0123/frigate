"""Deregistering a stationary object drops only that object from norfair."""

import unittest
from types import SimpleNamespace

from frigate.track.norfair_tracker import NorfairTracker


def _norfair_object(global_id: int, hit_counter: int) -> SimpleNamespace:
    return SimpleNamespace(global_id=global_id, hit_counter=hit_counter)


class TestDeregisterWithMaxFrames(unittest.TestCase):
    def test_other_objects_of_the_label_are_kept(self):
        """D54 (upstream #24418): the filter used to keep an object only when
        it was both not the target and already expiring, so every healthy car
        was dropped along with the one leaving."""
        norfair = SimpleNamespace(
            tracked_objects=[
                _norfair_object(1, 5),
                _norfair_object(2, 5),
                _norfair_object(3, -1),
            ]
        )
        max_frames = SimpleNamespace(objects={"car": 10}, default=None)
        tracker = SimpleNamespace(
            tracked_objects={"a": {"label": "car"}},
            disappeared={"a": 0},
            track_id_map={"1": "a"},
            detect_config=SimpleNamespace(
                stationary=SimpleNamespace(max_frames=max_frames)
            ),
            get_tracker=lambda _label: norfair,
        )

        NorfairTracker.deregister(tracker, "a", "1")  # type: ignore[arg-type]

        self.assertEqual([o.global_id for o in norfair.tracked_objects], [2, 3])
        self.assertEqual(tracker.track_id_map, {})


if __name__ == "__main__":
    unittest.main(verbosity=2)
