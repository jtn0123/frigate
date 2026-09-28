"""Tests for the recording clip download stream."""

import os
import subprocess as sp
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from frigate.api.media import (
    _ClipStage,
    _run_clip_download,
    _run_staged_clip_download,
)

# more than the 64 KB a pipe holds, so an undrained stderr blocks ffmpeg
STDERR_FLOOD_BYTES = 256 * 1024
PAYLOAD = b"0123456789" * 512


def fake_ffmpeg(*statements: str) -> list[str]:
    """Build an argv that stands in for ffmpeg, running the given statements."""
    return [sys.executable, "-c", "\n".join(("import sys, time", *statements))]


class TestRunClipDownload(unittest.TestCase):
    def setUp(self):
        handle, self.playlist_path = tempfile.mkstemp(suffix=".txt")
        os.close(handle)

    def tearDown(self):
        if os.path.exists(self.playlist_path):
            os.unlink(self.playlist_path)

    def collect(self, ffmpeg_cmd: list[str], timeout: float = 30.0) -> bytes:
        """Drain the generator on a worker thread so a deadlock fails the test."""
        chunks: list[bytes] = []
        errors: list[BaseException] = []

        def drain() -> None:
            try:
                chunks.extend(_run_clip_download(ffmpeg_cmd, self.playlist_path))
            except BaseException as err:
                errors.append(err)

        thread = threading.Thread(target=drain, daemon=True)
        thread.start()
        thread.join(timeout)

        self.assertFalse(
            thread.is_alive(), "clip download did not finish, ffmpeg is deadlocked"
        )

        if errors:
            raise errors[0]

        return b"".join(chunks)

    def test_streams_full_clip_when_ffmpeg_floods_stderr(self):
        """A warning flood past the pipe buffer must not stall the download."""
        data = self.collect(
            fake_ffmpeg(
                f"sys.stderr.write('w' * {STDERR_FLOOD_BYTES})",
                "sys.stderr.flush()",
                f"sys.stdout.buffer.write({PAYLOAD!r})",
            )
        )

        self.assertEqual(data, PAYLOAD)
        self.assertFalse(os.path.exists(self.playlist_path))

    def test_streams_clip_written_before_stderr_flood(self):
        data = self.collect(
            fake_ffmpeg(
                f"sys.stdout.buffer.write({PAYLOAD!r})",
                "sys.stdout.flush()",
                f"sys.stderr.write('w' * {STDERR_FLOOD_BYTES})",
            )
        )

        self.assertEqual(data, PAYLOAD)

    def test_logs_ffmpeg_output_and_removes_playlist_on_failure(self):
        with patch("frigate.api.media.logger") as logger:
            data = self.collect(
                fake_ffmpeg(
                    "sys.stderr.write('something went wrong')",
                    "sys.exit(1)",
                )
            )

        self.assertEqual(data, b"")
        logger.error.assert_called_once()
        self.assertIn("something went wrong", logger.error.call_args.args[1])
        self.assertFalse(os.path.exists(self.playlist_path))

    def test_logs_only_the_tail_of_a_flooded_stderr(self):
        with patch("frigate.api.media.logger") as logger:
            self.collect(
                fake_ffmpeg(
                    f"sys.stderr.write('w' * {STDERR_FLOOD_BYTES})",
                    "sys.exit(1)",
                )
            )

        logged = logger.error.call_args.args[1]
        self.assertLess(len(logged), STDERR_FLOOD_BYTES)

    def test_does_not_log_a_successful_download(self):
        with patch("frigate.api.media.logger") as logger:
            self.collect(fake_ffmpeg(f"sys.stdout.buffer.write({PAYLOAD!r})"))

        logger.error.assert_not_called()

    def test_removes_playlist_when_ffmpeg_cannot_start(self):
        with self.assertRaises(OSError):
            self.collect(["/nonexistent-ffmpeg-binary"])

        self.assertFalse(os.path.exists(self.playlist_path))

    def test_closes_the_stdout_pipe_after_a_successful_download(self):
        processes: list[sp.Popen] = []
        real_popen = sp.Popen

        def spy(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            processes.append(process)
            return process

        with patch("subprocess.Popen", spy):
            self.collect(fake_ffmpeg(f"sys.stdout.buffer.write({PAYLOAD!r})"))

        self.assertTrue(processes[0].stdout.closed)

    def test_terminating_a_lingering_ffmpeg_is_not_logged_as_a_failure(self):
        """A complete download whose ffmpeg overstays is a success, not an error."""
        lingering = fake_ffmpeg(
            "import os",
            f"os.write(1, {PAYLOAD!r})",
            "os.close(1)",
            "time.sleep(30)",
        )

        with patch("frigate.api.media.CLIP_FFMPEG_EXIT_TIMEOUT", 0.5):
            with patch("frigate.api.media.logger") as logger:
                data = self.collect(lingering)

        self.assertEqual(data, PAYLOAD)
        logger.error.assert_not_called()

    def test_client_disconnect_kills_ffmpeg_and_removes_playlist(self):
        processes: list[sp.Popen] = []
        real_popen = sp.Popen

        def spy(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            processes.append(process)
            return process

        forever = fake_ffmpeg(
            "while True:",
            "    sys.stdout.buffer.write(b'x' * 4096)",
            "    sys.stdout.flush()",
        )

        with patch("subprocess.Popen", spy):
            stream = _run_clip_download(forever, self.playlist_path)
            self.assertTrue(next(stream))
            # Starlette never closes the generator itself, so a real disconnect
            # reaches this path only once the frame is finalized
            stream.close()

        self.assertIsNotNone(processes[0].poll(), "ffmpeg outlived the request")
        self.assertFalse(os.path.exists(self.playlist_path))


class TestRunStagedClipDownload(unittest.TestCase):
    """A mixed clip renders each stream run to its own file before streaming."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.playlist_path = os.path.join(self.tmp, "playlist.txt")
        with open(self.playlist_path, "w") as f:
            f.write("playlist")
        self.dests = [os.path.join(self.tmp, f"stage_{i}.mp4") for i in range(2)]

    def tearDown(self):
        for name in os.listdir(self.tmp):
            os.unlink(os.path.join(self.tmp, name))
        os.rmdir(self.tmp)

    def stage(self, index: int, *statements: str) -> _ClipStage:
        """A stage whose fake ffmpeg copies its concat list into the dest."""
        dest = self.dests[index]
        copy = f"open({dest!r}, 'wb').write(sys.stdin.buffer.read())"
        return _ClipStage(f"run {index}", dest, fake_ffmpeg(*statements, copy))

    def test_stages_every_run_then_streams_and_cleans_up(self):
        # the final pass sees both staged files, in order
        final = fake_ffmpeg(
            *(
                f"sys.stdout.buffer.write(open({dest!r}, 'rb').read())"
                for dest in self.dests
            )
        )

        data = b"".join(
            _run_staged_clip_download(
                [self.stage(0), self.stage(1)], final, self.playlist_path
            )
        )

        self.assertEqual(data, b"run 0run 1")
        self.assertEqual(os.listdir(self.tmp), [])

    def test_failed_stage_stops_and_cleans_up(self):
        failing = self.stage(0, "sys.stderr.write('bad input')", "sys.exit(1)")
        never = self.stage(1)
        final = fake_ffmpeg("sys.stdout.buffer.write(b'unreachable')")

        with patch("frigate.api.media.logger") as logger:
            data = b"".join(
                _run_staged_clip_download([failing, never], final, self.playlist_path)
            )

        self.assertEqual(data, b"")
        logger.error.assert_called_once()
        self.assertIn("bad input", logger.error.call_args.args[1])
        self.assertEqual(os.listdir(self.tmp), [])
