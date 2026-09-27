"""Tests for the download timeout of ModelDownloader.download_from_url."""

import socket
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from frigate.util import downloader, runtime_deps
from frigate.util.downloader import ModelDownloader
from frigate.util.runtime_deps import Artifact, ArtifactKind, RuntimeDependencyError

# the test gives up on a download that has not failed by then
JOIN_TIMEOUT_S = 10

# captured before any test patches the module constant
DEFAULT_TIMEOUT = downloader.DOWNLOAD_TIMEOUT


class SilentServer:
    """Accepts TCP connections and never sends a byte, like a stuck proxy."""

    def __init__(self) -> None:
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(4)
        self.connections: list[socket.socket] = []
        self.thread = threading.Thread(target=self._accept, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.sock.getsockname()[1]}/model.bin"

    def _accept(self) -> None:
        try:
            while True:
                connection, _ = self.sock.accept()
                self.connections.append(connection)
        except OSError:
            return

    def close(self) -> None:
        for connection in self.connections:
            connection.close()

        self.sock.close()


class TestDownloadTimeout(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.server = SilentServer()
        self.addCleanup(self.server.close)
        downloader.last_download_error.clear()
        # a short read timeout keeps the test fast; the value is still a
        # (connect, read) pair like the real one
        timeout_patch = patch.object(downloader, "DOWNLOAD_TIMEOUT", (5, 0.5))
        timeout_patch.start()
        self.addCleanup(timeout_patch.stop)

    def _run(self, target) -> list[BaseException]:
        """Run target on a thread and return what it raised."""
        errors: list[BaseException] = []

        def body() -> None:
            try:
                target()
            except BaseException as e:
                errors.append(e)

        thread = threading.Thread(target=body, daemon=True)
        thread.start()
        thread.join(JOIN_TIMEOUT_S)
        self.assertFalse(thread.is_alive(), "download hung on a silent server")
        return errors

    def test_passes_a_connect_and_read_timeout(self):
        with patch.object(downloader.requests, "get") as get:
            get.return_value.__enter__.return_value.iter_content.return_value = [b"x"]
            save_path = str(Path(self.tmp.name) / "model.bin")
            ModelDownloader.download_from_url("http://x/model.bin", save_path)

        self.assertEqual(get.call_args.kwargs["timeout"], downloader.DOWNLOAD_TIMEOUT)

    def test_default_timeout_is_a_connect_read_pair(self):
        connect, read = DEFAULT_TIMEOUT
        self.assertGreater(connect, 0)
        self.assertGreater(read, 0)

    def test_silent_server_fails_instead_of_hanging(self):
        save_path = str(Path(self.tmp.name) / "model.bin")

        errors = self._run(
            lambda: ModelDownloader.download_from_url(
                self.server.url, save_path, silent=True
            )
        )

        self.assertEqual(len(errors), 1)
        self.assertIn(save_path, downloader.last_download_error)
        self.assertFalse(Path(save_path).exists())

    def test_runtime_fetch_reports_the_timeout_as_a_dependency_error(self):
        cache = Path(self.tmp.name) / "cache"
        cache.mkdir()
        artifact = Artifact(
            url=self.server.url, sha256="0" * 64, kind=ArtifactKind.wheel
        )

        errors = self._run(lambda: runtime_deps._fetch(artifact, cache))

        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], RuntimeDependencyError)
        self.assertIn(self.server.url, str(errors[0]))


if __name__ == "__main__":
    unittest.main()
