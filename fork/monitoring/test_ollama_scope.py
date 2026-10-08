"""Reproduce service worker attribution without cameras, models or host access."""

import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import collect_proxmox as collector


class OllamaScopeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.proc = self.root / "proc"
        self.proc.mkdir()
        self.cgroup = self.root / "cgroup"
        self.group = self.cgroup / "lxc/108"
        self.service = self.group / "ns/system.slice/ollama.service"
        self.service.mkdir(parents=True)
        (self.service / "cpu.stat").write_text("usage_usec 123456000\n")
        (self.service / "cgroup.procs").write_text("110\n111\n")
        worker_group = self.service / "worker"
        worker_group.mkdir()
        (worker_group / "cgroup.procs").write_text("112\n111\n")
        self.process(100, "init", "lxc/108/ns/init.scope", 1)
        self.process(110, "ollama", "lxc/108/ns/system.slice/ollama.service", 17)
        self.process(
            111,
            "llama-server",
            "lxc/108/ns/system.slice/ollama.service",
            18,
            rss=1000000,
        )
        self.process(
            112,
            "model-worker",
            "lxc/108/ns/system.slice/ollama.service/worker",
            19,
            rss=400000,
        )
        self.process(113, "ffmpeg", "lxc/108/ns/ffmpeg", 20, rss=1000000)
        self.process(
            114, "llama-server", "lxc/108/ns/unrelated.service", 21, rss=1000000
        )
        self.process(
            115, "ollama", "lxc/109/ns/system.slice/ollama.service", 17, rss=1000000
        )
        self.systemctl = Mock(
            return_value=(
                "ActiveState=active\nMainPID=17\n"
                "ControlGroup=/system.slice/ollama.service\n"
            )
        )
        self.cpu = Mock(return_value=12.5)
        self.enterContext(patch.object(collector, "Path", side_effect=self.path))
        self.enterContext(patch.object(collector, "CGROUP", self.cgroup))
        self.enterContext(patch.object(collector, "init_pid", return_value=100))
        self.enterContext(
            patch.object(
                collector.os,
                "sysconf",
                side_effect=lambda key: 4096 if key == "SC_PAGE_SIZE" else 100,
            )
        )
        self.enterContext(
            patch.object(collector.subprocess, "check_output", self.systemctl)
        )

    def path(self, value):
        path = str(value)
        return self.root / path.lstrip("/") if path.startswith("/proc") else Path(value)

    def process(self, pid, name, cgroup, namespace_pid, rss=2, start=50):
        proc = self.proc / str(pid)
        proc.mkdir(exist_ok=True)
        fields = ["0"] * 22
        fields[11], fields[12], fields[19], fields[21] = (
            "100",
            "50",
            str(start),
            str(rss),
        )
        (proc / "stat").write_text(f"{pid} ({name}) " + " ".join(fields))
        (proc / "comm").write_text(name)
        (proc / "cgroup").write_text("0::/" + cgroup + "\n")
        (proc / "status").write_text(f"NSpid:\t{pid}\t{namespace_pid}\n")

    def test_includes_service_workers_and_excludes_unrelated_processes(self):
        rows = collector.collect_ollama(self.group, "108", self.cpu, 100)
        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["memory_bytes"], 1400002 * collector.os.sysconf("SC_PAGE_SIZE")
        )
        self.assertEqual(rows[0]["cpu_percent"], 12.5)
        self.cpu.assert_called_once_with("ollama:108:110:50", 123.456)

    def test_service_properties_only_and_no_process_arguments_are_read(self):
        with patch.object(
            collector, "kernel_text", wraps=collector.kernel_text
        ) as read:
            collector.collect_ollama(self.group, "108", self.cpu, 100)
        self.systemctl.assert_called_once_with(
            [
                "pct",
                "exec",
                "108",
                "--",
                "systemctl",
                "show",
                "ollama.service",
                "--property=ActiveState,MainPID,ControlGroup",
            ],
            text=True,
            timeout=5,
        )
        self.assertLessEqual(
            {call.args[0].name for call in read.call_args_list},
            {"stat", "status", "cgroup", "cgroup.procs"},
        )

    def test_inactive_service_has_no_ollama_scope(self):
        self.systemctl.return_value = "ActiveState=inactive\nMainPID=0\nControlGroup=\n"
        self.assertEqual(collector.collect_ollama(self.group, "108", self.cpu, 100), [])
        self.cpu.assert_not_called()

    def test_host_pid_is_not_confused_with_container_service_pid(self):
        self.systemctl.return_value = self.systemctl.return_value.replace(
            "MainPID=17", "MainPID=110"
        )
        with self.assertRaisesRegex(ValueError, "main process unavailable"):
            collector.collect_ollama(self.group, "108", self.cpu, 100)
        self.cpu.assert_not_called()

    def test_container_init_is_verified_before_using_its_namespace_depth(self):
        (self.proc / "100/status").write_text("NSpid:\t100\t17\n")
        with self.assertRaisesRegex(ValueError, "init namespace identity"):
            collector.collect_ollama(self.group, "108", self.cpu, 100)

    def test_container_init_outside_requested_group_is_unknown(self):
        (self.proc / "100/cgroup").write_text("0::/lxc/109/ns/init.scope\n")
        with self.assertRaisesRegex(ValueError, "outside requested cgroup"):
            collector.collect_ollama(self.group, "108", self.cpu, 100)

    def test_service_main_must_still_be_a_member(self):
        (self.service / "cgroup.procs").write_text("111\n")
        with self.assertRaisesRegex(ValueError, "main process left"):
            collector.collect_ollama(self.group, "108", self.cpu, 100)

    def test_namespace_and_kernel_identity_counters_are_validated(self):
        for value in ("NSpid:\t100\t0\n", "NSpid:\t200\t1\n", "NSpid:\n"):
            (self.proc / "100/status").write_text(value)
            with (
                self.subTest(value=value),
                self.assertRaisesRegex(ValueError, "namespace identity"),
            ):
                collector.collect_ollama(self.group, "108", self.cpu, 100)
        (self.proc / "100/status").write_text("NSpid:\t100\t1\n")
        for start, rss in ((-1, 2), (50, -1)):
            self.process(100, "init", "lxc/108/ns/init.scope", 1, start=start, rss=rss)
            with (
                self.subTest(start=start, rss=rss),
                self.assertRaisesRegex(ValueError, "Invalid process counters"),
            ):
                collector.collect_ollama(self.group, "108", self.cpu, 100)
        (self.proc / "100/stat").write_text("200 (init) " + "0 " * 22)
        with self.assertRaisesRegex(ValueError, "Process identity changed"):
            collector.collect_ollama(self.group, "108", self.cpu, 100)

    def test_invalid_kernel_cgroup_path_and_service_member_are_unknown(self):
        (self.proc / "100/cgroup").write_text("0::/../lxc/108\n")
        with self.assertRaisesRegex(ValueError, "Invalid unified cgroup"):
            collector.collect_ollama(self.group, "108", self.cpu, 100)
        (self.proc / "100/cgroup").write_text("0::/lxc/108/ns/init.scope\n")
        (self.service / "cgroup.procs").write_text("110\n0\n")
        with self.assertRaisesRegex(ValueError, "Invalid service process ID"):
            collector.collect_ollama(self.group, "108", self.cpu, 100)

    def test_invalid_service_metadata_is_unknown(self):
        for value in (
            "",
            "ActiveState=active\nMainPID=0\nControlGroup=/system.slice/ollama.service\n",
            "ActiveState=active\nMainPID=17\nControlGroup=system.slice/ollama.service\n",
            "ActiveState=active\nMainPID=17\nControlGroup=/../ollama.service\n",
            "ActiveState=activating\nMainPID=17\nControlGroup=/system.slice/ollama.service\n",
            "x" * 4097,
        ):
            with self.subTest(value=value[:30]):
                self.systemctl.return_value = value
                with self.assertRaises(ValueError):
                    collector.collect_ollama(self.group, "108", self.cpu, 100)
        self.cpu.assert_not_called()

    def test_service_query_failure_is_unknown(self):
        self.systemctl.side_effect = subprocess.TimeoutExpired("systemctl", 5)
        with self.assertRaises(subprocess.TimeoutExpired):
            collector.collect_ollama(self.group, "108", self.cpu, 100)
        self.cpu.assert_not_called()

    def test_missing_worker_does_not_become_server_only_memory(self):
        (self.proc / "111/stat").unlink()
        with self.assertRaises(FileNotFoundError):
            collector.collect_ollama(self.group, "108", self.cpu, 100)
        self.cpu.assert_not_called()

    def test_pid_reused_during_collection_invalidates_the_sample(self):
        identity = collector.process_identity
        service_members = collector.service_members
        worker_reads = 0
        measuring = False

        def members(group):
            nonlocal measuring
            measuring = True
            return service_members(group)

        def reused(pid):
            nonlocal worker_reads
            start, memory = identity(pid)
            if pid == 111 and measuring:
                worker_reads += 1
                if worker_reads > 1:
                    start += 1
            return start, memory

        with (
            patch.object(collector, "process_identity", side_effect=reused),
            patch.object(collector, "service_members", side_effect=members),
        ):
            with self.assertRaisesRegex(ValueError, "identity changed"):
                collector.collect_ollama(self.group, "108", self.cpu, 100)
        self.cpu.assert_not_called()

    def test_reused_pid_outside_service_is_excluded_and_sample_is_unknown(self):
        (self.proc / "111/cgroup").write_text("0::/lxc/108/ns/unrelated.service\n")
        with self.assertRaisesRegex(ValueError, "left Ollama service"):
            collector.collect_ollama(self.group, "108", self.cpu, 100)

    def test_changed_cgroup_membership_invalidates_sample(self):
        with patch.object(
            collector, "service_members", side_effect=[{110, 111}, {110}]
        ):
            with self.assertRaisesRegex(ValueError, "membership changed"):
                collector.collect_ollama(self.group, "108", self.cpu, 100)

    def test_collection_is_bounded(self):
        for bound in (
            "MAX_HOST_PROCESSES",
            "MAX_SERVICE_PROCESSES",
            "MAX_SERVICE_GROUPS",
        ):
            with self.subTest(bound=bound), patch.object(collector, bound, 1):
                with self.assertRaisesRegex(ValueError, "collection bound"):
                    collector.collect_ollama(self.group, "108", self.cpu, 100)
        self.cpu.assert_not_called()

    def test_cpu_is_per_core_and_unknown_after_service_restart(self):
        (self.proc / "meminfo").write_text(
            "MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 100 kB\nSwapFree: 50 kB\n"
        )
        (self.proc / "stat").write_text("cpu 100 0 20 500 0 0 0 0\n")
        (self.proc / "vmstat").write_text("oom_kill 0\n")
        (self.group / "cpu.stat").write_text("usage_usec 1000000000\n")
        (self.group / "memory.events").write_text("oom_kill 0\n")
        with (
            patch.object(
                collector.os,
                "statvfs",
                return_value=SimpleNamespace(
                    f_bavail=2,
                    f_frsize=4096,
                    f_blocks=10,
                ),
            ),
            patch.object(collector.time, "time", side_effect=[60, 120, 180]),
        ):
            first = collector.sample(["108"], {})
            self.assertEqual(first["status"], "connected")
            self.assertIsNone(first["scopes"][2]["cpu_percent"])
            (self.service / "cpu.stat").write_text("usage_usec 243456000\n")
            second = collector.sample(["108"], first)
            self.assertAlmostEqual(second["scopes"][2]["cpu_percent"], 200)
            # A recycled host PID with a new start time begins a fresh interval,
            # even when the new service's CPU counter is larger than the old one.
            self.process(
                110, "ollama", "lxc/108/ns/system.slice/ollama.service", 17, start=75
            )
            (self.service / "cpu.stat").write_text("usage_usec 500000000\n")
            third = collector.sample(["108"], second)
            self.assertIsNone(third["scopes"][2]["cpu_percent"])

    def test_missing_or_invalid_service_counters_are_unknown(self):
        for value in ("", "usage_usec invalid", "usage_usec -1"):
            (self.service / "cpu.stat").write_text(value)
            with self.subTest(value=value), self.assertRaises((ValueError, KeyError)):
                collector.collect_ollama(self.group, "108", self.cpu, 100)

    def test_bounded_kernel_reads_and_cgroup_symlinks_are_rejected(self):
        path = self.root / "oversized"
        path.write_text("x" * 20)
        with self.assertRaises(ValueError):
            collector.kernel_text(path, 10)
        (self.service / "redirect").symlink_to(self.group)
        with self.assertRaisesRegex(ValueError, "symlink"):
            collector.collect_ollama(self.group, "108", self.cpu, 100)


if __name__ == "__main__":
    unittest.main()
