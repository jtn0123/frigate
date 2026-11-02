"""capture_frames reads ffmpeg frames straight into shared memory (B34, #24640)."""

import io
import queue
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np

from frigate.video.ffmpeg import capture_frames

FRAME_SHAPE = (4, 6)
FRAME_SIZE = FRAME_SHAPE[0] * FRAME_SHAPE[1]


class FakeFrameManager:
    def __init__(self, count: int) -> None:
        self.buffers = {f"cam_frame{i}": bytearray(FRAME_SIZE) for i in range(count)}
        self.times = np.zeros(count, dtype=np.float64)

    def frame_times(self, camera: str) -> np.ndarray:
        return self.times

    def write(self, name: str) -> memoryview:
        return memoryview(self.buffers[name])

    def close(self, name: str) -> None:
        pass


def _run(
    data: bytes, frames: int = 3, queue_size: int = 0
) -> tuple[FakeFrameManager, queue.Queue]:
    process = MagicMock()
    process.stdout = io.BufferedReader(io.BytesIO(data))
    process.poll.return_value = 0
    manager = FakeFrameManager(frames)
    frame_queue: queue.Queue = queue.Queue(maxsize=queue_size)
    capture_frames(
        process,
        SimpleNamespace(name="cam", enabled=True),
        frames,
        0,
        FRAME_SHAPE,
        manager,
        frame_queue,
        SimpleNamespace(value=0.0),
        SimpleNamespace(value=0.0),
        SimpleNamespace(value=0.0),
        threading.Event(),
    )
    return manager, frame_queue


class TestCaptureReadinto(unittest.TestCase):
    def test_full_frames_land_in_shared_memory(self) -> None:
        data = bytes([1]) * FRAME_SIZE + bytes([2]) * FRAME_SIZE
        manager, frame_queue = _run(data)

        names = [frame_queue.get_nowait()[0] for _ in range(frame_queue.qsize())]
        self.assertEqual(names, ["cam_frame0", "cam_frame1"])
        self.assertEqual(bytes(manager.buffers["cam_frame0"]), bytes([1]) * FRAME_SIZE)
        self.assertEqual(bytes(manager.buffers["cam_frame1"]), bytes([2]) * FRAME_SIZE)
        # B43 (upstream #24644): each queued slot is stamped with its frame time
        self.assertGreater(manager.times[0], 0)
        self.assertGreater(manager.times[1], 0)
        self.assertEqual(manager.times[2], 0)

    def test_full_queue_reuses_the_slot(self) -> None:
        # B43 (upstream #24644): no reader was told about a dropped frame, so
        # the next frame overwrites its slot instead of advancing the ring
        data = b"".join(bytes([value]) * FRAME_SIZE for value in (1, 2, 3))
        manager, frame_queue = _run(data, queue_size=1)

        self.assertEqual(frame_queue.get_nowait()[0], "cam_frame0")
        self.assertEqual(bytes(manager.buffers["cam_frame0"]), bytes([1]) * FRAME_SIZE)
        self.assertEqual(bytes(manager.buffers["cam_frame1"]), bytes([3]) * FRAME_SIZE)
        self.assertEqual(bytes(manager.buffers["cam_frame2"]), bytes(FRAME_SIZE))

    def test_incomplete_frame_is_not_queued(self) -> None:
        data = bytes([1]) * FRAME_SIZE + bytes([2]) * (FRAME_SIZE // 2)
        manager, frame_queue = _run(data)

        self.assertEqual(frame_queue.qsize(), 1)
        self.assertEqual(frame_queue.get_nowait()[0], "cam_frame0")
        # the torn slot is never stamped, so no reader can match it
        self.assertEqual(manager.times[1], 0)


if __name__ == "__main__":
    unittest.main()
