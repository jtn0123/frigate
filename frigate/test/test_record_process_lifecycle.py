"""Keep recording I/O available until its real child-process worker stops."""

import asyncio
import importlib.util
import multiprocessing as mp
import os
import signal
import sys
import tempfile
import threading
import time
import unittest
from multiprocessing.connection import Connection
from multiprocessing.synchronize import Event as MpEvent
from pathlib import Path
from types import ModuleType, SimpleNamespace

from frigate.fork.recording_quarantine import (
    QUARANTINE_SECONDS,
    RecordingQuarantine,
)


class _ProcessSetupStub(mp.Process):
    def __init__(
        self, stop_event: MpEvent, priority: int, *, name: str, daemon: bool
    ) -> None:
        super().__init__(name=name, daemon=daemon)
        self.stop_event = stop_event

    def pre_run_setup(self, config: object) -> None:
        pass


def _run_recording_child(
    directory: str,
    connection: Connection,
    stop_event: MpEvent,
    run_returned: MpEvent,
    shutdown_started: MpEvent,
) -> None:
    """Exercise the source process run method with real bootstrap and async I/O."""
    lifetime_ready = threading.Event()

    def observe_executor_shutdown() -> None:
        shutdown_started.set()
        lifetime_ready.set()

    # Exit callbacks run in reverse registration order. Register the observer
    # first, then initialize the real executor so old code releases our worker
    # only after multiprocessing has shut that executor down.
    if "concurrent.futures.thread" in sys.modules:
        raise AssertionError("The child must initialize its own fresh executor")
    threading._register_atexit(observe_executor_shutdown)
    asyncio.run(asyncio.to_thread(lambda: None))

    class LifecycleMaintainer(threading.Thread):
        def __init__(self, config: object, stop: MpEvent) -> None:
            super().__init__(daemon=False)
            self.stop_event = stop
            self.quarantine = RecordingQuarantine(Path(directory) / ".integrity")

        def join(self, timeout: float | None = None) -> None:
            # Observe the explicit production join without replacing its wait.
            lifetime_ready.set()
            super().join(timeout)

        async def maintain(self, sequence: int) -> Path:
            await asyncio.to_thread(self.quarantine.prune)
            return await asyncio.to_thread(
                self.quarantine.preserve,
                Path(directory) / f"segment-{sequence}.mp4",
                "synthetic",
                "main",
                "probe_failed",
            )

        def run(self) -> None:
            connection.send(("ready",))
            try:
                if not lifetime_ready.wait(10):
                    raise TimeoutError("Recording lifetime handshake timed out")
                while not self.stop_event.is_set():
                    if not connection.poll(0.05):
                        continue
                    sequence = connection.recv()
                    saved = asyncio.run(self.maintain(sequence))
                    connection.send(("saved", sequence, saved.read_bytes()))
            except (OSError, RuntimeError, TimeoutError) as error:
                connection.send(("error", type(error).__name__, str(error)))
            finally:
                connection.send(("closed",))

    def dependency(name: str, **attributes: object) -> ModuleType:
        module = ModuleType(name)
        module.__dict__.update(attributes)
        return module

    dependencies = {
        "playhouse.sqliteq": dependency(
            "playhouse.sqliteq",
            SqliteQueueDatabase=lambda *args, **kwargs: SimpleNamespace(
                bind=lambda models: None
            ),
        ),
        "frigate.config": dependency("frigate.config", FrigateConfig=SimpleNamespace),
        "frigate.const": dependency("frigate.const", PROCESS_PRIORITY_HIGH=0),
        "frigate.models": dependency(
            "frigate.models", Recordings=object(), ReviewSegment=object()
        ),
        "frigate.record.maintainer": dependency(
            "frigate.record.maintainer", RecordingMaintainer=LifecycleMaintainer
        ),
        "frigate.util.process": dependency(
            "frigate.util.process", FrigateProcess=_ProcessSetupStub
        ),
    }
    previous = {name: sys.modules.get(name) for name in dependencies}
    sys.modules.update(dependencies)
    try:
        spec = importlib.util.spec_from_file_location(
            "record_process_lifecycle_subject",
            Path(__file__).parents[1] / "record" / "record.py",
        )
        if spec is None or spec.loader is None:
            raise AssertionError("Recording process source could not be loaded")
        subject = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(subject)
    finally:
        for name, original in previous.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original

    config = SimpleNamespace(
        logger=None,
        database=SimpleNamespace(path="unused.sqlite"),
        cameras={"synthetic": SimpleNamespace(enabled=True)},
    )
    try:
        subject.RecordProcess(config, stop_event).run()
    finally:
        run_returned.set()


class TestRecordProcessLifecycle(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        for sequence in (1, 2):
            (self.directory / f"segment-{sequence}.mp4").write_bytes(
                f"evidence-{sequence}".encode()
            )
        self.expired = self.directory / ".integrity" / "integrity-expired.mp4"
        self.expired.parent.mkdir()
        self.expired.write_bytes(b"expired")
        expired_at = time.time() - QUARANTINE_SECONDS - 1
        os.utime(self.expired, (expired_at, expired_at))

    def start_child(self) -> tuple[mp.Process, Connection, MpEvent, MpEvent, MpEvent]:
        context = mp.get_context("forkserver")
        parent, child = context.Pipe()
        stop_event = context.Event()
        run_returned = context.Event()
        shutdown_started = context.Event()
        process = context.Process(
            target=_run_recording_child,
            args=(
                self.temporary.name,
                child,
                stop_event,
                run_returned,
                shutdown_started,
            ),
            daemon=True,
        )
        process.start()
        child.close()

        def cleanup() -> None:
            stop_event.set()
            process.join(5)
            if process.is_alive():
                process.terminate()
                process.join(5)
            if process.is_alive():
                process.kill()
                process.join(5)
            parent.close()
            process.close()

        self.addCleanup(cleanup)
        self.assertTrue(parent.poll(10), "Recording worker did not start")
        self.assertEqual(parent.recv(), ("ready",))
        return process, parent, stop_event, run_returned, shutdown_started

    def assert_saved(self, connection: Connection, sequence: int) -> None:
        connection.send(sequence)
        self.assertTrue(connection.poll(10), "Recording I/O did not finish")
        self.assertEqual(
            connection.recv(), ("saved", sequence, f"evidence-{sequence}".encode())
        )

    def test_delayed_quarantine_io_remains_available_until_shared_stop(self) -> None:
        process, connection, stop_event, returned, shutdown = self.start_child()
        self.assert_saved(connection, 1)
        self.assert_saved(connection, 2)
        self.assertFalse(self.expired.exists())
        self.assertFalse((self.directory / "segment-1.mp4").exists())
        self.assertFalse((self.directory / "segment-2.mp4").exists())
        self.assertEqual(len(list(self.expired.parent.glob("integrity-*.mp4"))), 2)
        self.assertTrue(process.is_alive())
        self.assertFalse(returned.is_set())
        self.assertFalse(shutdown.is_set())

        stop_event.set()
        self.assertTrue(connection.poll(10), "Recording worker did not stop")
        self.assertEqual(connection.recv(), ("closed",))
        process.join(10)
        self.assertFalse(process.is_alive())
        self.assertEqual(process.exitcode, 0)
        self.assertTrue(returned.is_set())
        self.assertTrue(shutdown.is_set())

    def test_sigterm_still_terminates_joined_recording_process(self) -> None:
        process, connection, stop_event, returned, shutdown = self.start_child()
        self.assert_saved(connection, 1)
        self.assertFalse(stop_event.is_set())
        self.assertFalse(returned.is_set())
        self.assertFalse(shutdown.is_set())

        process.terminate()
        process.join(10)
        self.assertFalse(process.is_alive())
        self.assertEqual(process.exitcode, -signal.SIGTERM)


if __name__ == "__main__":
    unittest.main()
