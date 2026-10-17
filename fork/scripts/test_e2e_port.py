"""Preview allocation uses real Git inventories and excludes occupied ports."""

import importlib.util
import io
import socket
import subprocess
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "e2e_port", Path(__file__).with_name("e2e-port.py")
)
PORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PORT)


class TestPreviewPort(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.main = self.root / "main"
        self.main.mkdir()
        self.run_git("init", "--quiet", self.main)
        self.run_git(
            "-C",
            self.main,
            "-c",
            "user.name=Port test",
            "-c",
            "user.email=port@example.invalid",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "initial",
        )
        self.other = self.root / "other"
        self.run_git(
            "-C", self.main, "worktree", "add", "--quiet", "--detach", self.other
        )

    def run_git(self, *args):
        subprocess.run(["git", *map(str, args)], check=True, capture_output=True)

    def test_exhaustion_fails_without_creating_a_shared_default(self):
        with patch.object(PORT, "available", return_value=True):
            self.assertEqual(PORT.reserve(self.main, start=4190, end=4190), 4190)
            with self.assertRaisesRegex(RuntimeError, "No unique"):
                PORT.reserve(self.other, start=4190, end=4190)
        self.assertFalse((self.other / "web/.e2e-port").exists())

    def test_concurrent_worktrees_receive_different_ports(self):
        with (
            patch.object(PORT, "available", return_value=True),
            ThreadPoolExecutor(max_workers=2) as executor,
        ):
            jobs = [
                executor.submit(PORT.reserve, tree, None, 4190, 4191)
                for tree in (self.main, self.other)
            ]
            self.assertEqual({job.result() for job in jobs}, {4190, 4191})

    def test_explicit_reserved_or_occupied_ports_fail(self):
        with patch.object(PORT, "available", return_value=True):
            PORT.reserve(self.main, requested=4190)
            with self.assertRaises(RuntimeError):
                PORT.reserve(self.other, requested=4190)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            with self.assertRaises(RuntimeError):
                PORT.reserve(self.other, requested=listener.getsockname()[1])

    def test_duplicate_old_records_are_reassigned(self):
        with patch.object(PORT, "available", return_value=True):
            PORT.reserve(self.main, requested=4190)
            record = self.other / "web/.e2e-port"
            record.parent.mkdir()
            record.write_text("4190\n")
            self.assertEqual(PORT.reserve(self.other, start=4190, end=4191), 4191)

    def test_sequential_previews_can_rebind_after_serving_connections(self):
        for family, address in (
            (socket.AF_INET, "127.0.0.1"),
            (socket.AF_INET6, "::1"),
        ):
            with self.subTest(address=address):
                with socket.socket(family, socket.SOCK_STREAM) as listener:
                    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    listener.bind((address, 0))
                    listener.listen()
                    port = listener.getsockname()[1]
                    with self.assertRaises(RuntimeError):
                        PORT.reserve(self.main, requested=port)
                    with socket.create_connection((address, port), timeout=3) as client:
                        connection, _ = listener.accept()
                        # An orderly server-side close leaves TCP TIME_WAIT behind.
                        connection.close()
                        self.assertEqual(client.recv(1), b"")
                self.assertEqual(PORT.reserve(self.main, requested=port), port)

    def test_invalid_records_and_explicit_ports_are_rejected(self):
        for value in ("", "0", "65536", "4190junk"):
            with self.assertRaises(ValueError):
                PORT.port_number(value)

    def test_command_publishes_and_prints_the_reserved_port(self):
        output = io.StringIO()
        with (
            patch("sys.argv", ["e2e-port.py", "--worktree", str(self.main)]),
            patch.object(PORT, "available", return_value=True),
            redirect_stdout(output),
        ):
            PORT.main()
        self.assertEqual(output.getvalue(), "4190\n")
        self.assertEqual((self.main / "web/.e2e-port").read_text(), "4190\n")

    def test_command_fails_clearly_without_a_port_record(self):
        for extra in ([], ["--requested", "65536"]):
            error = io.StringIO()
            with (
                patch(
                    "sys.argv", ["e2e-port.py", "--worktree", str(self.main), *extra]
                ),
                patch.object(PORT, "available", return_value=False),
                redirect_stderr(error),
                self.assertRaises(SystemExit) as failure,
            ):
                PORT.main()
            self.assertEqual(failure.exception.code, 1)
            self.assertTrue(error.getvalue().strip())
            self.assertFalse((self.main / "web/.e2e-port").exists())
