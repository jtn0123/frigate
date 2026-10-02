"""Coverage tests for the parsing and probing helpers in frigate.util.services."""

import asyncio
import io
import json
import subprocess as sp
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from frigate.const import (
    DRIVER_AMD,
    DRIVER_ENV_VAR,
    FFMPEG_HWACCEL_NVIDIA,
    FFMPEG_HWACCEL_VAAPI,
    SHM_FRAMES_VAR,
)
from frigate.util import services
from frigate.util.fork_shm import ShmUsage

MOD = "frigate.util.services"


def fake_open(files: dict):
    """Build an open() replacement backed by a path to content mapping.

    A value that is an exception instance is raised instead of returned.
    Paths missing from the mapping raise FileNotFoundError.
    """

    def _open(path, *args, **kwargs):
        if path not in files:
            raise FileNotFoundError(path)
        value = files[path]
        if isinstance(value, BaseException):
            raise value
        return io.StringIO(value)

    return _open


def completed(returncode=0, stdout="", stderr=""):
    return sp.CompletedProcess(
        args=[], returncode=returncode, stdout=stdout, stderr=stderr
    )


class TestRestartAndSignals(unittest.TestCase):
    def test_restart_terminates_s6(self):
        proc = MagicMock()
        proc.name.return_value = "s6-svscan"
        with (
            patch(f"{MOD}.psutil.Process", return_value=proc),
            patch(f"{MOD}.os.kill") as kill,
        ):
            services.restart_frigate()
        proc.terminate.assert_called_once()
        kill.assert_not_called()

    def test_restart_sends_sigint_without_s6(self):
        proc = MagicMock()
        proc.name.return_value = "python3"
        with (
            patch(f"{MOD}.psutil.Process", return_value=proc),
            patch(f"{MOD}.os.kill") as kill,
            patch(f"{MOD}.os.getpid", return_value=4242),
        ):
            services.restart_frigate()
        proc.terminate.assert_not_called()
        kill.assert_called_once_with(4242, services.signal.SIGINT)

    def test_listen_registers_print_stack(self):
        with patch(f"{MOD}.signal.signal") as sig:
            services.listen()
        sig.assert_called_once_with(services.signal.SIGUSR1, services.print_stack)

    def test_print_stack_prints_frame(self):
        with patch(f"{MOD}.traceback.print_stack") as ps:
            services.print_stack(None, "frame")
        ps.assert_called_once_with("frame")


class TestCgroups(unittest.TestCase):
    def _run(self, mounts):
        with (
            patch(f"{MOD}.os.path.ismount", return_value=True),
            patch("builtins.open", fake_open({"/proc/mounts": mounts})),
        ):
            return services.get_cgroups_version()

    def test_not_a_mount(self):
        with patch(f"{MOD}.os.path.ismount", return_value=False):
            self.assertEqual(services.get_cgroups_version(), "unknown")

    def test_cgroup2fs(self):
        mounts = "proc /proc proc rw 0 0\ncgroup2 /sys/fs/cgroup cgroup2 rw 0 0\n"
        self.assertEqual(self._run(mounts), "cgroup2")

    def test_cgroup2fs_type_name(self):
        self.assertEqual(self._run("x /sys/fs/cgroup cgroup2fs rw 0 0\n"), "cgroup2")

    def test_tmpfs_is_v1(self):
        self.assertEqual(self._run("tmpfs /sys/fs/cgroup tmpfs rw 0 0\n"), "cgroup")

    def test_unhandled_fs(self):
        self.assertEqual(self._run("x /sys/fs/cgroup ext4 rw 0 0\n"), "unknown")

    def test_no_matching_mount(self):
        self.assertEqual(self._run("x /other ext4 rw 0 0\n"), "unknown")

    def test_read_error(self):
        with (
            patch(f"{MOD}.os.path.ismount", return_value=True),
            patch("builtins.open", fake_open({})),
        ):
            self.assertEqual(services.get_cgroups_version(), "unknown")


class TestDockerMemlimit(unittest.TestCase):
    def _run(self, version, files):
        with (
            patch(f"{MOD}.get_cgroups_version", return_value=version),
            patch("builtins.open", fake_open(files)),
        ):
            return services.get_docker_memlimit_bytes()

    def test_numeric_limit(self):
        path = "/sys/fs/cgroup/memory.max"
        self.assertEqual(self._run("cgroup2", {path: "1048576\n"}), 1048576)

    def test_max_means_unlimited(self):
        self.assertEqual(
            self._run("cgroup2", {"/sys/fs/cgroup/memory.max": "max\n"}), -1
        )

    def test_garbage_value(self):
        self.assertEqual(self._run("cgroup2", {"/sys/fs/cgroup/memory.max": "abc"}), -1)

    def test_read_error(self):
        self.assertEqual(self._run("cgroup2", {}), -1)

    def test_cgroup_v1(self):
        self.assertEqual(self._run("cgroup", {}), -1)


class TestCpuStats(unittest.TestCase):
    def _proc(self, pid, cmdline, cpu=5.0):
        return SimpleNamespace(
            info={"pid": pid, "name": "x", "cpu_percent": cpu, "cmdline": cmdline}
        )

    def _sysconf(self, name):
        return {"SC_PAGE_SIZE": 4096, "SC_PHYS_PAGES": 1024 * 1024, 2: 100}[name]

    def _run(self, memlimit):
        stat = ["0"] * 22
        stat[13] = "1000"
        stat[14] = "1000"
        stat[21] = "10000"
        files = {
            "/proc/10/stat": " ".join(stat) + "\n",
            "/proc/uptime": "300.5 100.0\n",
            "/proc/10/statm": "100 2560 0 0 0 0 0\n",
        }
        procs = [
            self._proc(10, ["ffmpeg", "-i", "rtsp://user:pass@cam/stream"]),
            self._proc(11, ["bash"]),
            self._proc(12, ["python3", "x"]),  # no /proc files, swallowed
            self._proc(13, None),  # join on None raises, swallowed
        ]
        with (
            patch(f"{MOD}.get_docker_memlimit_bytes", return_value=memlimit),
            patch(f"{MOD}.os.sysconf", side_effect=self._sysconf),
            patch(f"{MOD}.os.sysconf_names", {"SC_CLK_TCK": 2}),
            patch(f"{MOD}.psutil.cpu_percent", return_value=12.5),
            patch(
                f"{MOD}.psutil.virtual_memory",
                return_value=SimpleNamespace(percent=40.0),
            ),
            patch(f"{MOD}.psutil.process_iter", return_value=procs),
            patch("builtins.open", fake_open(files)),
        ):
            return services.get_cpu_stats()

    def test_parses_process_with_total_memory(self):
        usages = self._run(-1)
        self.assertEqual(usages["frigate.full_system"], {"cpu": "12.5", "mem": "40.0"})
        self.assertEqual(set(usages), {"frigate.full_system", "10"})
        entry = usages["10"]
        self.assertEqual(entry["cpu"], "5.0")
        # utime + stime = 20 s, elapsed = 300 - 100 = 200 s -> 10%
        self.assertEqual(entry["cpu_average"], "10")
        # 2560 pages * 4 KiB = 10240 KiB of 4 GiB total
        self.assertEqual(entry["mem"], "0.2")
        self.assertNotIn("pass", entry["cmdline"])

    def test_uses_docker_memlimit(self):
        usages = self._run(10240 * 1024 * 2)
        self.assertEqual(usages["10"]["mem"], "50.0")


class TestNetwork(unittest.TestCase):
    def test_no_interfaces(self):
        self.assertEqual(services.get_physical_interfaces([]), [])

    def test_matches_prefixes(self):
        dev = (
            "Inter-|   Receive\n"
            " face |bytes\n"
            "    lo: 1 2\n"
            "  eth0: 1 2\n"
            "  enp3s0: 1 2\n"
            "  wlan0: 1 2\n"
        )
        with patch("builtins.open", fake_open({"/proc/net/dev": dev})):
            self.assertEqual(
                services.get_physical_interfaces(["eth", "enp"]), ["eth0", "enp3s0"]
            )

    def _config(self):
        return SimpleNamespace(telemetry=SimpleNamespace(network_interfaces=["eth"]))

    def test_bandwidth_error(self):
        with (
            patch(f"{MOD}.get_physical_interfaces", return_value=["eth0"]),
            patch(f"{MOD}.sp.run", return_value=completed(1, stderr="boom")) as run,
        ):
            self.assertEqual(services.get_bandwidth_stats(self._config()), {})
        self.assertEqual(run.call_args[0][0][-1], "eth0")

    def test_bandwidth_parses(self):
        out = "\n".join(
            [
                "Refreshing:",
                "ffmpeg/123/0\t1.5\t2.25",
                "/usr/bin/go2rtc/77/0\t0.1\t0.2",
                "/usr/bin/python3 frigate.detector.cpu/88/0\t3\t4",
                "sshd/9/0\t1\t1",
                "ffmpeg/124/0\tbad\t1",
                "",
            ]
        )
        with (
            patch(f"{MOD}.get_physical_interfaces", return_value=[]),
            patch(f"{MOD}.sp.run", return_value=completed(0, stdout=out)),
        ):
            usages = services.get_bandwidth_stats(self._config())
        self.assertEqual(
            usages,
            {
                "123": {"bandwidth": 3.8},
                "77": {"bandwidth": 0.3},
                "88": {"bandwidth": 7.0},
            },
        )


class TestVaapiAndAmd(unittest.TestCase):
    def test_env_driver_amd(self):
        with patch.dict(f"{MOD}.os.environ", {DRIVER_ENV_VAR: DRIVER_AMD}):
            self.assertTrue(services.is_vaapi_amd_driver())

    def test_env_driver_other(self):
        with patch.dict(f"{MOD}.os.environ", {DRIVER_ENV_VAR: "iHD"}):
            self.assertFalse(services.is_vaapi_amd_driver())

    def _no_env(self):
        env = dict(services.os.environ)
        env.pop(DRIVER_ENV_VAR, None)
        return patch.dict(f"{MOD}.os.environ", env, clear=True)

    def test_vainfo_failure(self):
        with (
            self._no_env(),
            patch(f"{MOD}.vainfo_hwaccel", return_value=completed(1, stderr=b"x")),
        ):
            self.assertFalse(services.is_vaapi_amd_driver())

    def test_vainfo_detects_amd(self):
        out = b"vainfo: Driver version: Mesa Gallium driver for AMD Radeon Graphics\n"
        with (
            self._no_env(),
            patch(f"{MOD}.vainfo_hwaccel", return_value=completed(0, stdout=out)),
        ):
            self.assertTrue(services.is_vaapi_amd_driver())

    def test_vainfo_detects_intel(self):
        out = b"vainfo: Driver version: Intel iHD driver\n"
        with (
            self._no_env(),
            patch(f"{MOD}.vainfo_hwaccel", return_value=completed(0, stdout=out)),
        ):
            self.assertFalse(services.is_vaapi_amd_driver())

    def test_amd_gpu_stats_failure(self):
        with patch(f"{MOD}.sp.run", return_value=completed(1, stderr="no gpu")):
            self.assertIsNone(services.get_amd_gpu_stats())

    def test_amd_gpu_stats_parses(self):
        out = "1664525.0: bus 03, gpu 12.50%, ee 0.00%, vram 33.10% 1352.65mb"
        with patch(f"{MOD}.sp.run", return_value=completed(0, stdout=out)):
            self.assertEqual(
                services.get_amd_gpu_stats(), {"gpu": "12.50%", "mem": "33.10%"}
            )


class TestVainfoHwaccel(unittest.TestCase):
    def _cmd(self, device):
        with patch(f"{MOD}.sp.run", return_value=completed()) as run:
            services.vainfo_hwaccel(device)
        return run.call_args[0][0]

    def test_no_device(self):
        self.assertEqual(self._cmd(None), ["vainfo"])

    def test_absolute_device(self):
        self.assertEqual(
            self._cmd("/dev/dri/renderD129"),
            ["vainfo", "--display", "drm", "--device", "/dev/dri/renderD129"],
        )

    def test_bare_device_name(self):
        self.assertEqual(self._cmd("renderD128")[-1], "/dev/dri/renderD128")

    def test_absolute_outside_dri_is_prefixed(self):
        self.assertEqual(self._cmd("/tmp/evil")[-1], "/dev/dri//tmp/evil")


class TestIntelDevices(unittest.TestCase):
    def test_resolve_none(self):
        self.assertIsNone(services._resolve_intel_gpu_pdev(None))
        self.assertIsNone(services._resolve_intel_gpu_pdev(""))

    def test_resolve_pci_address(self):
        self.assertEqual(
            services._resolve_intel_gpu_pdev("0000:00:02.0"), "0000:00:02.0"
        )

    def test_resolve_render_node(self):
        with patch(
            f"{MOD}.os.path.realpath",
            return_value="/sys/devices/pci0000:00/0000:00:02.0",
        ) as rp:
            self.assertEqual(
                services._resolve_intel_gpu_pdev("/dev/dri/renderD128/"),
                "0000:00:02.0",
            )
        rp.assert_called_once_with("/sys/class/drm/renderD128/device")

    def test_resolve_nonexistent(self):
        with patch(
            f"{MOD}.os.path.realpath", return_value="/sys/class/drm/card9/device"
        ):
            self.assertIsNone(services._resolve_intel_gpu_pdev("card9"))

    def test_resolve_oserror(self):
        with patch(f"{MOD}.os.path.realpath", side_effect=OSError):
            self.assertIsNone(services._resolve_intel_gpu_pdev("card0"))

    def test_enumerate_listdir_error(self):
        with patch(f"{MOD}.os.listdir", side_effect=OSError):
            self.assertEqual(services.enumerate_drm_devices(), {})

    def test_enumerate_devices(self):
        realpaths = {
            "/sys/class/drm/card0/device": "/sys/devices/pci0000:00/0000:00:02.0",
            "/sys/class/drm/card1/device": "/sys/devices/pci0000:00/0000:03:00.0",
            "/sys/class/drm/card2/device": "/sys/devices/pci0000:00/0000:04:00.0",
            "/sys/class/drm/version/device": "/sys/class/drm/version/device",
        }
        links = {
            "/sys/class/drm/card0/device/driver": "../../bus/pci/drivers/i915",
            "/sys/class/drm/card1/device/driver": "../../bus/pci/drivers/amdgpu",
        }

        def readlink(path):
            if path not in links:
                raise OSError(path)
            return links[path]

        with (
            patch(
                f"{MOD}.os.listdir",
                return_value=["card0", "card1", "card2", "version"],
            ),
            patch(f"{MOD}.os.path.realpath", side_effect=realpaths.__getitem__),
            patch(f"{MOD}.os.readlink", side_effect=readlink),
        ):
            self.assertEqual(
                services.enumerate_drm_devices(),
                {"0000:00:02.0": "i915", "0000:03:00.0": "amdgpu"},
            )


class TestReadIntelFdinfo(unittest.TestCase):
    I915 = (
        "drm-driver:\ti915\n"
        "drm-pdev:\t0000:00:02.0\n"
        "drm-client-id:\t7\n"
        "drm-engine-render:\t1000 ns\n"
        "drm-engine-video:\tbad ns\n"
        "drm-engine-compute:\t\n"
        "no separator line\n"
    )
    XE = (
        "drm-driver: xe\n"
        "drm-pdev: 0000:03:00.0\n"
        "drm-client-id: 9\n"
        "drm-cycles-rcs: 500\n"
        "drm-total-cycles-rcs: 1000\n"
        "drm-cycles-vcs: 40\n"
        "drm-total-cycles-vcs: 100\n"
        "drm-engine-capacity-vcs: 2\n"
        "drm-cycles-vecs: 1\n"
        "drm-total-cycles-vecs: 2\n"
        "drm-engine-capacity-vecs: junk\n"
        "drm-cycles-ccs: bad\n"
        "drm-total-cycles-ccs: 5\n"
    )

    def _run(self, target):
        dirs = {
            "/proc": ["1", "2", "3", "self", "4"],
            "/proc/1/fdinfo": ["0", "1", "2", "3"],
            "/proc/2/fdinfo": ["5", "6", "7", "8"],
        }

        def listdir(path):
            if path not in dirs:
                raise OSError(path)
            return dirs[path]

        files = {
            "/proc/1/fdinfo/0": "pos: 0\n",
            "/proc/1/fdinfo/1": self.I915,
            "/proc/1/fdinfo/2": self.I915,  # duplicate client, collapsed
            "/proc/1/fdinfo/3": OSError("gone"),
            "/proc/2/fdinfo/5": self.XE,
            "/proc/2/fdinfo/6": "drm-driver: amdgpu\ndrm-client-id: 1\n",
            "/proc/2/fdinfo/7": "drm-driver: i915\ndrm-pdev: 0000:00:02.0\n",
            "/proc/2/fdinfo/8": "drm-driver: xe\ndrm-pdev: 0000:03:00.0\n"
            "drm-client-id: 10\n",
        }
        with (
            patch(f"{MOD}.os.listdir", side_effect=listdir),
            patch("builtins.open", fake_open(files)),
        ):
            return services._read_intel_drm_fdinfo(target)

    def test_proc_unreadable(self):
        with patch(f"{MOD}.os.listdir", side_effect=OSError):
            self.assertIsNone(services._read_intel_drm_fdinfo(None))

    def test_parses_all_clients(self):
        snap = self._run(None)
        self.assertEqual(
            snap[("0000:00:02.0", "7", "1")],
            {"driver": "i915", "pid": "1", "engines": {"render": (1000, 0, 1)}},
        )
        self.assertEqual(
            snap[("0000:03:00.0", "9", "2")]["engines"],
            {
                "render": (500, 1000, 1),
                "video": (40, 100, 2),
                "video-enhance": (1, 2, 1),
            },
        )
        self.assertEqual(snap[("0000:03:00.0", "10", "2")]["engines"], {})
        self.assertEqual(len(snap), 3)

    def test_filters_by_pdev(self):
        snap = self._run("0000:00:02.0")
        self.assertEqual(list(snap), [("0000:00:02.0", "7", "1")])


class TestIntelGpuStats(unittest.TestCase):
    PDEV = "0000:00:02.0"

    def _run(self, snapshots, monotonic=(0.0, 1.0), names=None, device=None):
        with (
            patch(
                f"{MOD}.enumerate_drm_devices",
                return_value={self.PDEV: "i915", "0000:03:00.0": "xe"},
            ),
            patch(f"{MOD}._read_intel_drm_fdinfo", side_effect=snapshots),
            patch(f"{MOD}.time.sleep"),
            patch(f"{MOD}.time.monotonic", side_effect=list(monotonic)),
            patch(
                "frigate.stats.intel_gpu_info.intel_gpu_name_resolver.get_names",
                return_value=names or {},
            ),
        ):
            return services.get_intel_gpu_stats(device)

    def _client(self, driver, pid, engines):
        return {"driver": driver, "pid": pid, "engines": engines}

    def test_second_snapshot_unreadable(self):
        a = {(self.PDEV, "1", "10"): self._client("i915", "10", {"render": (0, 0, 1)})}
        self.assertIsNone(self._run([a, None]))

    def test_idle_with_target_pdev(self):
        result = self._run([{}], device=self.PDEV, names={self.PDEV: "Arc A380"})
        self.assertEqual(list(result), [self.PDEV])
        self.assertEqual(result[self.PDEV]["name"], "Arc A380")
        self.assertEqual(result[self.PDEV]["gpu"], "0.0%")

    def test_zero_elapsed_reports_idle(self):
        a = {(self.PDEV, "1", "10"): self._client("i915", "10", {"render": (0, 0, 1)})}
        result = self._run([a, a], monotonic=(5.0, 5.0))
        self.assertEqual(sorted(result), [self.PDEV, "0000:03:00.0"])
        self.assertEqual(result[self.PDEV]["compute"], "0.0%")

    def test_no_persisted_clients_reports_idle(self):
        a = {(self.PDEV, "1", "10"): self._client("i915", "10", {"render": (0, 0, 1)})}
        b = {
            (self.PDEV, "2", "11"): self._client("i915", "11", {"render": (5, 0, 1)}),
            (self.PDEV, "1", "10"): self._client("xe", "10", {"render": (5, 5, 1)}),
            (self.PDEV, "3", "12"): self._client("i915", "12", {}),
        }
        a[(self.PDEV, "3", "12")] = self._client("i915", "12", {})
        result = self._run([a, b])
        self.assertEqual(result[self.PDEV]["gpu"], "0.0%")
        self.assertNotIn("clients", result[self.PDEV])

    def test_mixed_engines_and_clamping(self):
        xe = "0000:03:00.0"
        a = {
            (self.PDEV, "1", "10"): self._client(
                "i915",
                "10",
                {"render": (0, 0, 1), "video": (0, 0, 1)},
            ),
            (xe, "2", "20"): self._client(
                "xe",
                "20",
                {"compute": (0, 0, 1), "video-enhance": (0, 100, 1)},
            ),
        }
        b = {
            (self.PDEV, "1", "10"): self._client(
                "i915",
                "10",
                {
                    # 2e9 ns busy over 1 s clamps to 100%
                    "render": (2_000_000_000, 0, 1),
                    "video": (250_000_000, 0, 1),
                    # engine absent from snapshot A, defaults to zero delta
                    "video-enhance": (999, 0, 1),
                    "bogus": (1, 1, 1),
                },
            ),
            (xe, "2", "20"): self._client(
                "xe",
                "20",
                {
                    "compute": (50, 100, 1),
                    # total did not advance, skipped
                    "video-enhance": (10, 100, 1),
                },
            ),
        }
        result = self._run([a, b])
        self.assertEqual(result[self.PDEV]["compute"], "100.0%")
        self.assertEqual(result[self.PDEV]["dec"], "25.0%")
        self.assertEqual(result[self.PDEV]["gpu"], "100.0%")
        self.assertEqual(result[self.PDEV]["clients"], {"10": "100.0%"})
        self.assertEqual(result[xe]["compute"], "50.0%")
        self.assertEqual(result[xe]["dec"], "0.0%")
        self.assertEqual(result[xe]["gpu"], "50.0%")
        self.assertEqual(result[xe]["name"], "Intel iGPU")

    def test_device_hint_resolves(self):
        a = {}
        with patch(f"{MOD}._resolve_intel_gpu_pdev", return_value=self.PDEV):
            result = self._run([a], device="card0")
        self.assertEqual(list(result), [self.PDEV])


class TestNpuAndEmbeddedStats(unittest.TestCase):
    NPU = "/sys/devices/pci0000:00/0000:00:0b.0/power/runtime_active_time"

    def _openvino(self, values, times):
        reads = iter(values)

        def _open(path, *args, **kwargs):
            self.assertEqual(path, self.NPU)
            value = next(reads)
            if isinstance(value, BaseException):
                raise value
            return io.StringIO(value)

        with (
            patch("builtins.open", _open),
            patch(f"{MOD}.time.sleep"),
            patch(f"{MOD}.time.time", side_effect=list(times)),
        ):
            return services.get_openvino_npu_stats()

    def test_openvino_usage(self):
        self.assertEqual(
            self._openvino(["1000\n", "1250\n"], (10.0, 11.0)),
            {"npu": "25.0", "mem": "-%"},
        )

    def test_openvino_clamps(self):
        self.assertEqual(self._openvino(["0", "5000"], (10.0, 11.0))["npu"], "100.0")

    def test_openvino_zero_time(self):
        self.assertEqual(self._openvino(["0", "5"], (10.0, 10.0))["npu"], "0.0")

    def test_openvino_missing(self):
        self.assertIsNone(self._openvino([FileNotFoundError()], ()))

    def test_openvino_bad_value(self):
        self.assertIsNone(self._openvino(["abc"], ()))

    def test_rockchip_gpu(self):
        files = {
            "/sys/kernel/debug/rkrga/load": "scheduler[0]: rga3\n\t load = 10%\n"
            "scheduler[1]: rga2\n\t load = 25%\n",
            "/sys/class/thermal/thermal_zone5/temp": "45678\n",
        }
        with patch("builtins.open", fake_open(files)):
            self.assertEqual(
                services.get_rockchip_gpu_stats(),
                {"gpu": "17.5%", "mem": "-%", "temp": 45.7},
            )

    def test_rockchip_gpu_bad_temp(self):
        files = {
            "/sys/kernel/debug/rkrga/load": "load = 3%\n",
            "/sys/class/thermal/thermal_zone5/temp": "hot\n",
        }
        with patch("builtins.open", fake_open(files)):
            self.assertEqual(
                services.get_rockchip_gpu_stats(), {"gpu": "3.0%", "mem": "-%"}
            )

    def test_rockchip_gpu_missing_or_empty(self):
        with patch("builtins.open", fake_open({})):
            self.assertIsNone(services.get_rockchip_gpu_stats())
        files = {"/sys/kernel/debug/rkrga/load": "nothing here\n"}
        with patch("builtins.open", fake_open(files)):
            self.assertIsNone(services.get_rockchip_gpu_stats())

    def test_rockchip_npu_multi_core(self):
        files = {
            "/sys/kernel/debug/rknpu/load": "NPU load:  Core0: 10%, Core1: 20%, "
            "Core2: 31%,\n",
            "/sys/class/thermal/thermal_zone6/temp": "50000",
        }
        with patch("builtins.open", fake_open(files)):
            self.assertEqual(
                services.get_rockchip_npu_stats(),
                {"npu": 20.33, "mem": "-%", "temp": 50.0},
            )

    def test_rockchip_npu_single_core_no_temp(self):
        files = {"/sys/kernel/debug/rknpu/load": "NPU load:  42%\n"}
        with patch("builtins.open", fake_open(files)):
            self.assertEqual(
                services.get_rockchip_npu_stats(), {"npu": 42.0, "mem": "-%"}
            )

    def test_rockchip_npu_missing(self):
        with patch("builtins.open", fake_open({})):
            self.assertIsNone(services.get_rockchip_npu_stats())

    def test_axcl_missing_binary(self):
        with patch(f"{MOD}.os.path.exists", return_value=False):
            self.assertIsNone(services.get_axcl_npu_stats())

    def _axcl(self, result):
        with (
            patch(f"{MOD}.os.path.exists", return_value=True),
            patch(f"{MOD}.sp.run", **result) as run,
        ):
            value = services.get_axcl_npu_stats()
        return value, run

    def test_axcl_parses(self):
        out = "  npu top\n  utilization:37%\n  utilization:bad\n"
        value, run = self._axcl({"return_value": completed(0, stdout=out)})
        self.assertEqual(value, {"npu": 37.0, "mem": "-%"})
        self.assertEqual(run.call_args[0][0][-1], "/proc/ax_proc/npu/top")

    def test_axcl_no_utilization(self):
        value, _ = self._axcl({"return_value": completed(0, stdout="idle\n")})
        self.assertIsNone(value)

    def test_axcl_failure(self):
        value, _ = self._axcl({"return_value": completed(1)})
        self.assertIsNone(value)

    def test_axcl_exception(self):
        value, _ = self._axcl({"side_effect": OSError("nope")})
        self.assertIsNone(value)

    def _jetson(self, existing, files):
        with (
            patch(f"{MOD}.os.path.exists", side_effect=lambda p: p in existing),
            patch("builtins.open", fake_open(files)),
        ):
            return services.get_jetson_stats()

    def test_jetson_gpu0(self):
        path = "/sys/devices/gpu.0/load"
        self.assertEqual(
            self._jetson({path}, {path: "455\n"}), {"mem": "-", "gpu": "45.5%"}
        )

    def test_jetson_platform_gpu(self):
        path = "/sys/devices/platform/gpu.0/load"
        self.assertEqual(
            self._jetson({path}, {path: "100\n"}), {"mem": "-", "gpu": "10.0%"}
        )

    def test_jetson_none(self):
        self.assertEqual(self._jetson(set(), {}), {"mem": "-", "gpu": "-"})

    def test_jetson_bad_value(self):
        path = "/sys/devices/gpu.0/load"
        self.assertIsNone(self._jetson({path}, {path: "x"}))


class FakeNVMLError(Exception):
    pass


class TestNvidia(unittest.TestCase):
    def _nvml(self, names, not_supported=()):
        nvml = MagicMock()
        nvml.NVMLError_NotSupported = FakeNVMLError
        nvml.nvmlDeviceGetCount.return_value = len(names)
        nvml.nvmlDeviceGetHandleByIndex.side_effect = lambda i: f"h{i}"
        nvml.nvmlDeviceGetName.side_effect = lambda h: names[int(h[1:])]
        nvml.nvmlDeviceGetMemoryInfo.return_value = SimpleNamespace(
            used=256, total=1024
        )
        nvml.nvmlDeviceGetUtilizationRates.return_value = SimpleNamespace(gpu=42)
        nvml.nvmlDeviceGetEncoderUtilization.return_value = (7, 1000)
        nvml.nvmlDeviceGetDecoderUtilization.return_value = (9, 1000)
        nvml.nvmlDeviceGetTemperature.return_value = 61
        nvml.nvmlDeviceGetPowerState.return_value = 2
        nvml.nvmlSystemGetDriverVersion.return_value = "550.54"
        nvml.nvmlDeviceGetCudaComputeCapability.return_value = (8, 6)
        nvml.nvmlDeviceGetVbiosVersion.return_value = "94.02"
        for attr in not_supported:
            getattr(nvml, attr).side_effect = FakeNVMLError()
        return nvml

    def test_try_get_info_variants(self):
        nvml = self._nvml([])
        with patch(f"{MOD}.nvml", nvml):
            self.assertEqual(services.try_get_info(lambda: 1, None), 1)
            self.assertEqual(services.try_get_info(lambda h: h, "h"), "h")
            self.assertEqual(
                services.try_get_info(lambda h, s: (h, s), "h", sensor=0), ("h", 0)
            )

            def unsupported(h):
                raise FakeNVMLError()

            self.assertEqual(services.try_get_info(unsupported, "h"), "N/A")
            self.assertIsNone(services.try_get_info(unsupported, "h", default=None))

    def test_gpu_stats_with_duplicate_names(self):
        with patch(f"{MOD}.nvml", self._nvml(["RTX 3060", "RTX 3060"])):
            stats = services.get_nvidia_gpu_stats()
        self.assertEqual(
            stats[0],
            {
                "name": "RTX 3060",
                "gpu": 42,
                "mem": 25.0,
                "enc": 7,
                "dec": 9,
                "pstate": 2,
                "temp": 61.0,
            },
        )
        self.assertEqual(stats[1]["name"], "RTX 3060 (2)")

    def test_gpu_stats_unsupported_metrics(self):
        nvml = self._nvml(
            ["T4"],
            not_supported=(
                "nvmlDeviceGetMemoryInfo",
                "nvmlDeviceGetUtilizationRates",
                "nvmlDeviceGetEncoderUtilization",
                "nvmlDeviceGetDecoderUtilization",
                "nvmlDeviceGetTemperature",
                "nvmlDeviceGetPowerState",
            ),
        )
        with patch(f"{MOD}.nvml", nvml):
            stats = services.get_nvidia_gpu_stats()
        self.assertEqual(
            stats[0],
            {
                "name": "T4",
                "gpu": 0,
                "mem": -1,
                "enc": -1,
                "dec": -1,
                "pstate": "unknown",
                "temp": None,
            },
        )

    def test_driver_info(self):
        with patch(f"{MOD}.nvml", self._nvml(["A2000"])):
            info = services.get_nvidia_driver_info()
        self.assertEqual(
            info,
            {
                0: {
                    "name": "A2000",
                    "driver": "550.54",
                    "cuda_compute": (8, 6),
                    "vbios": "94.02",
                }
            },
        )

    def test_driver_info_unsupported(self):
        nvml = self._nvml(
            ["A2000"],
            not_supported=(
                "nvmlSystemGetDriverVersion",
                "nvmlDeviceGetCudaComputeCapability",
                "nvmlDeviceGetVbiosVersion",
            ),
        )
        with patch(f"{MOD}.nvml", nvml):
            info = services.get_nvidia_driver_info()
        self.assertEqual(
            info[0],
            {
                "name": "A2000",
                "driver": "unknown",
                "cuda_compute": "unknown",
                "vbios": "unknown",
            },
        )


class TestGo2rtcExec(unittest.TestCase):
    def _run(self, env=None, isdir=False, access=True, listing=(), files=None):
        files = files or {}
        with (
            patch(f"{MOD}._GO2RTC_ARBITRARY_EXEC_ENV", env),
            patch(f"{MOD}.os.path.isdir", return_value=isdir),
            patch(f"{MOD}.os.access", return_value=access),
            patch(f"{MOD}.os.listdir", return_value=list(listing)),
            patch(f"{MOD}.os.path.isfile", side_effect=lambda p: p in files),
            patch("builtins.open", fake_open(files)),
        ):
            return services.is_go2rtc_arbitrary_exec_allowed()

    def test_env_values(self):
        self.assertTrue(self._run(env="TRUE"))
        self.assertTrue(self._run(env="1"))
        self.assertTrue(self._run(env="yes"))
        self.assertFalse(self._run(env="false"))

    def test_docker_secret(self):
        secret = "/run/secrets/GO2RTC_ALLOW_ARBITRARY_EXEC"
        listing = ["GO2RTC_ALLOW_ARBITRARY_EXEC"]
        self.assertTrue(
            self._run(isdir=True, listing=listing, files={secret: " true\n"})
        )
        self.assertFalse(
            self._run(isdir=True, listing=listing, files={secret: OSError()})
        )

    def test_secret_dir_without_key_falls_back_to_options(self):
        options = {
            "/data/options.json": json.dumps({"go2rtc_allow_arbitrary_exec": True})
        }
        self.assertTrue(self._run(isdir=True, listing=["other"], files=options))

    def test_unreadable_secret_dir(self):
        self.assertFalse(self._run(isdir=True, access=False))

    def test_options_file(self):
        self.assertFalse(
            self._run(files={"/data/options.json": json.dumps({"other": 1})})
        )
        self.assertFalse(self._run(files={"/data/options.json": "{not json"}))

    def test_nothing_configured(self):
        self.assertFalse(self._run())

    def test_restricted_source(self):
        self.assertFalse(services.is_restricted_go2rtc_source("rtsp://cam/stream"))
        with patch(f"{MOD}.is_go2rtc_arbitrary_exec_allowed", return_value=False):
            self.assertTrue(services.is_restricted_go2rtc_source("  exec:ffmpeg"))
            self.assertTrue(services.is_restricted_go2rtc_source("echo:x"))
        with patch(f"{MOD}.is_go2rtc_arbitrary_exec_allowed", return_value=True):
            self.assertFalse(services.is_restricted_go2rtc_source("expr:x"))


class TestFfprobeStream(unittest.TestCase):
    FFMPEG = SimpleNamespace(ffprobe_path="/usr/bin/ffprobe")

    def test_detailed_adds_format_entries(self):
        with patch(f"{MOD}.sp.run", return_value=completed(0, stdout=b"{}")) as run:
            result = services.ffprobe_stream(
                self.FFMPEG, "http://cam/stream", detailed=True
            )
        self.assertEqual(result.returncode, 0)
        cmd = run.call_args[0][0]
        self.assertIn("format=format_name,size,bit_rate,duration", cmd)
        self.assertIn("codec_name", cmd[cmd.index("-show_entries") + 1])
        self.assertEqual(run.call_count, 1)

    def test_non_rtsp_failure_does_not_retry(self):
        with patch(f"{MOD}.sp.run", return_value=completed(1)) as run:
            services.ffprobe_stream(self.FFMPEG, "/media/file.mp4")
        self.assertEqual(run.call_count, 1)
        self.assertNotIn("-rtsp_transport", run.call_args[0][0])

    def test_timeout_without_output(self):
        err = sp.TimeoutExpired(cmd="ffprobe", timeout=6)
        with patch(f"{MOD}.sp.run", side_effect=err):
            result = services.ffprobe_stream(self.FFMPEG, "/media/file.mp4")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"\nffprobe timed out")


class TestKeyframes(unittest.TestCase):
    def test_parse_handles_nonfinite_and_flags(self):
        pts, max_pts = services.parse_keyframe_packets(
            "0.0,K_\n0.5,__\nnan,K_\ninf,K_\n2.0,K_\nonly\n1.0,__\n"
        )
        self.assertEqual(pts, [0.0, 2.0])
        self.assertEqual(max_pts, 2.0)

    def test_classify_warning_variable(self):
        result = services.classify_keyframe_gaps([0.0, 1.0, 6.0], 10)
        self.assertEqual(result["severity"], "warning")
        self.assertEqual(result["pattern"], "variable")
        self.assertEqual(result["mean_gap"], 3.0)
        self.assertEqual(result["thresholds"], {"warning": 4.0, "error": 10})

    def test_classify_error_fixed(self):
        result = services.classify_keyframe_gaps([0.0, 12.0, 24.0], 10)
        self.assertEqual(result["severity"], "error")
        self.assertEqual(result["pattern"], "fixed")


def make_proc(returncode, stdout=b"", communicate=None):
    proc = MagicMock()
    proc.returncode = returncode
    proc.communicate = communicate or AsyncMock(return_value=(stdout, b""))
    return proc


def fake_wait_for(results):
    """Build an asyncio.wait_for stand-in that yields results in order.

    The awaitable passed in is closed rather than awaited so no coroutine is
    left pending; exception instances in results are raised.
    """
    queue = list(results)

    async def _wait_for(awaitable, timeout=None):
        if asyncio.iscoroutine(awaitable):
            awaitable.close()
        value = queue.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value

    return _wait_for


class TestAnalyzeRecordKeyframes(unittest.IsolatedAsyncioTestCase):
    FFMPEG = SimpleNamespace(ffprobe_path="ffprobe")

    async def test_oserror_returns_unknown(self):
        with patch(
            f"{MOD}.asyncio.create_subprocess_exec",
            new=AsyncMock(side_effect=OSError("missing")),
        ):
            result = await services.analyze_record_keyframes(
                self.FFMPEG, "rtsp://cam", 10, window=1
            )
        self.assertEqual(result["severity"], "unknown")
        self.assertNotIn("duration_observed", result)

    async def test_no_packets_has_null_duration(self):
        proc = make_proc(0, b"")
        with patch(
            f"{MOD}.asyncio.create_subprocess_exec", new=AsyncMock(return_value=proc)
        ) as exec_mock:
            result = await services.analyze_record_keyframes(
                self.FFMPEG, "rtsp://cam", 10, window=3
            )
        self.assertIsNone(result["duration_observed"])
        self.assertIn("%+3", exec_mock.call_args[0])


class TestAutoDetectHwaccel(unittest.TestCase):
    def _run(self, status=200, data=None, error=None):
        resp = MagicMock(status_code=status)
        resp.json.return_value = data or {}
        kwargs = {"side_effect": error} if error else {"return_value": resp}
        with patch(f"{MOD}.requests.get", **kwargs):
            return services.auto_detect_hwaccel()

    def test_cuda(self):
        data = {
            "sources": [
                {"url": "ffmpeg:device?video=0#hardware=cuda", "name": "OK"},
                {"url": "ffmpeg:device?video=0#hardware=vaapi", "name": "OK"},
            ]
        }
        self.assertEqual(self._run(data=data), FFMPEG_HWACCEL_NVIDIA)

    def test_vaapi(self):
        data = {
            "sources": [
                {"url": "ffmpeg:#hardware=cuda", "name": "fail"},
                {"url": "ffmpeg:#hardware=vaapi", "name": "OK"},
            ]
        }
        self.assertEqual(self._run(data=data), FFMPEG_HWACCEL_VAAPI)

    def test_none_detected(self):
        self.assertEqual(self._run(data={"sources": [{"name": "OK"}]}), "")
        self.assertEqual(self._run(status=500), "")

    def test_request_error(self):
        err = services.requests.ConnectionError("down")
        self.assertEqual(self._run(error=err), "")


class FakeCapture:
    def __init__(self, opened=True, props=None):
        self.opened = opened
        self.props = props or {}
        self.released = False

    def isOpened(self):
        return self.opened

    def get(self, prop):
        return self.props.get(prop, 0)

    def release(self):
        self.released = True


def ffprobe_json(streams, duration=None):
    data: dict = {"streams": streams}
    if duration is not None:
        data["format"] = {"duration": duration}
    return json.dumps(data).encode()


class TestGetVideoProperties(unittest.IsolatedAsyncioTestCase):
    FFMPEG = SimpleNamespace(ffprobe_path="ffprobe")
    VIDEO = {"codec_type": "video", "width": 1920, "height": 1080, "codec_name": "h264"}

    def _cv2_props(self, fps=25.0, frames=250):
        cv2 = services.cv2
        return {
            cv2.CAP_PROP_FRAME_WIDTH: 640,
            cv2.CAP_PROP_FRAME_HEIGHT: 480,
            cv2.CAP_PROP_FOURCC: int.from_bytes(b"avc1", "little"),
            cv2.CAP_PROP_FPS: fps,
            cv2.CAP_PROP_FRAME_COUNT: frames,
        }

    async def _run(self, url, procs, capture=None, get_duration=False):
        exec_mock = AsyncMock(side_effect=procs)
        with (
            patch(f"{MOD}.asyncio.create_subprocess_exec", new=exec_mock),
            patch(
                f"{MOD}.cv2.VideoCapture", return_value=capture or FakeCapture(False)
            ),
        ):
            result = await services.get_video_properties(
                self.FFMPEG, url, get_duration=get_duration
            )
        return result, exec_mock

    async def test_rtsp_ffprobe_with_audio(self):
        out = ffprobe_json(
            [
                self.VIDEO,
                {"codec_type": "audio", "codec_name": "aac", "sample_rate": "16000"},
            ],
            duration="12.5",
        )
        result, exec_mock = await self._run(
            "rtsp://cam/stream", [make_proc(0, out)], get_duration=True
        )
        self.assertEqual(
            result,
            {
                "has_valid_video": True,
                "width": 1920,
                "height": 1080,
                "has_audio": True,
                "audio_rate": 16000,
                "audio_codec": "aac",
                "video_codec": "h264",
                "fourcc": "h264",
                "duration": 12.5,
            },
        )
        self.assertEqual(exec_mock.call_count, 1)

    async def test_rtsp_falls_back_to_tcp(self):
        out = ffprobe_json(
            [self.VIDEO, {"codec_type": "audio", "codec_name": "pcm_mulaw"}]
        )
        result, exec_mock = await self._run(
            "rtsp://cam/stream", [make_proc(1), make_proc(0, out)]
        )
        self.assertTrue(result["has_valid_video"])
        self.assertIsNone(result["audio_rate"])
        self.assertEqual(result["audio_codec"], "pcm_mulaw")
        self.assertNotIn("duration", result)
        second_cmd = exec_mock.call_args_list[1][0]
        self.assertEqual(second_cmd[1:3], ("-rtsp_transport", "tcp"))

    async def test_rtsp_no_video_streams(self):
        out = ffprobe_json([{"codec_type": "audio"}])
        result, _ = await self._run(
            "rtsp://cam/stream", [make_proc(0, out), make_proc(0, b"not json")]
        )
        self.assertEqual(result, {"has_valid_video": False})

    async def test_rtsp_timeout_kills_process(self):
        hung = make_proc(None)
        failed = make_proc(1)
        with patch(
            f"{MOD}.asyncio.wait_for",
            new=fake_wait_for([TimeoutError(), TimeoutError(), (b"", b"")]),
        ):
            result, _ = await self._run(
                "rtsp://cam/stream", [hung, failed], get_duration=True
            )
        hung.kill.assert_called_once()
        self.assertEqual(result, {"has_valid_video": False, "duration": -1})

    async def test_kill_process_lookup_error_suppressed(self):
        proc = make_proc(None)
        proc.kill.side_effect = ProcessLookupError
        with patch(
            f"{MOD}.asyncio.wait_for",
            new=fake_wait_for([(b"{}", b""), (b"", b"")]),
        ):
            result, _ = await self._run("http://cam/x", [proc])
        proc.kill.assert_called_once()
        self.assertEqual(result, {"has_valid_video": False})

    async def test_local_file_cv2_success(self):
        capture = FakeCapture(True, self._cv2_props())
        result, exec_mock = await self._run("/media/clip.mp4", [], capture=capture)
        self.assertEqual(
            result,
            {
                "has_valid_video": True,
                "width": 640,
                "height": 480,
                "has_audio": None,
                "audio_rate": None,
                "audio_codec": None,
                "video_codec": None,
                "fourcc": "avc1",
            },
        )
        self.assertTrue(capture.released)
        exec_mock.assert_not_called()

    async def test_local_file_cv2_fails_then_ffprobe(self):
        out = ffprobe_json([self.VIDEO])
        result, _ = await self._run("/media/clip.mp4", [make_proc(0, out)])
        self.assertTrue(result["has_valid_video"])
        self.assertFalse(result["has_audio"])
        self.assertEqual(result["fourcc"], "h264")

    async def test_duration_falls_back_to_cv2(self):
        capture = FakeCapture(True, self._cv2_props(fps=20.0, frames=100))
        out = ffprobe_json([self.VIDEO])  # no format duration
        result, _ = await self._run(
            "/media/clip.mp4", [make_proc(0, out)], capture=capture, get_duration=True
        )
        self.assertEqual(result["duration"], 5.0)
        self.assertEqual(result["width"], 640)
        self.assertIsNone(result["has_audio"])

    async def test_duration_cv2_zero_size(self):
        props = self._cv2_props()
        props[services.cv2.CAP_PROP_FRAME_WIDTH] = 0
        capture = FakeCapture(True, props)
        result, _ = await self._run(
            "/media/clip.mp4", [make_proc(1)], capture=capture, get_duration=True
        )
        self.assertEqual(result, {"has_valid_video": False, "duration": -1})

    async def test_duration_cv2_without_fps(self):
        capture = FakeCapture(True, self._cv2_props(fps=0.0))
        result, _ = await self._run(
            "/media/clip.mp4", [make_proc(1)], capture=capture, get_duration=True
        )
        self.assertTrue(result["has_valid_video"])
        self.assertEqual(result["duration"], -1.0)


class TestProcessLogs(unittest.TestCase):
    def test_dedups_frigate_messages(self):
        contents = "\n".join(
            [
                "short",
                "2024-01-01 00:00:01  [2024-01-01 00:00:01] frigate.app INFO : hi",
                "2024-01-01 00:00:02  [2024-01-01 00:00:02] frigate.app INFO : hi",
                "2024-01-01 00:00:03  [2024-01-01 00:00:03] frigate.app INFO : hi",
                "2024-01-01 00:00:04  no bracket message here",
                "2024-01-01 00:00:05  no bracket message here",
            ]
        )
        total, lines = services.process_logs(contents, service="frigate")
        self.assertEqual(total, 4)
        self.assertEqual(
            lines[1],
            "2024-01-01 00:00:01  [LOGGING] Last message repeated 2 times",
        )
        self.assertEqual(
            lines[3],
            "2024-01-01 00:00:04  [LOGGING] Last message repeated 1 times",
        )

    def test_non_frigate_service_and_slicing(self):
        contents = "\n".join(
            [
                "2024-01-01 00:00:01  a message one",
                "2024-01-01 00:00:02  a message two",
                "line without double space",
            ]
        )
        total, lines = services.process_logs(contents, service="go2rtc", start=1, end=3)
        self.assertEqual(total, 3)
        self.assertEqual(lines[0], "2024-01-01 00:00:02  a message two")
        self.assertTrue(lines[1].endswith("  line without double space"))

    def test_unparseable_line_kept(self):
        class Weird(str):
            def __contains__(self, item):
                return True

            def index(self, *args):
                raise ValueError

        class Contents(str):
            def splitlines(self):
                return [WeirdLine()]

        class WeirdLine(str):
            def __new__(cls):
                return super().__new__(cls, "some long log line")

            def strip(self):
                return Weird("some long log line")

        total, lines = services.process_logs(Contents(""))
        self.assertEqual((total, lines), (1, ["some long log line"]))


class TestSystemHelpers(unittest.TestCase):
    def test_set_file_limit_caps_at_hard(self):
        with (
            patch.dict(f"{MOD}.os.environ", {"SOFT_FILE_LIMIT": "100000"}),
            patch(f"{MOD}.resource.getrlimit", return_value=(1024, 4096)),
            patch(f"{MOD}.resource.setrlimit") as setr,
        ):
            services.set_file_limit()
        setr.assert_called_once_with(services.resource.RLIMIT_NOFILE, (4096, 4096))

    def test_set_file_limit_empty_env_uses_default(self):
        with (
            patch.dict(f"{MOD}.os.environ", {"SOFT_FILE_LIMIT": ""}),
            patch(f"{MOD}.resource.getrlimit", return_value=(1024, 1_000_000)),
            patch(f"{MOD}.resource.setrlimit") as setr,
        ):
            services.set_file_limit()
        self.assertEqual(setr.call_args[0][1], (65536, 1_000_000))

    def test_get_fs_type_longest_match(self):
        parts = [
            SimpleNamespace(mountpoint="/", fstype="overlay"),
            SimpleNamespace(mountpoint="/dev", fstype="devtmpfs"),
            SimpleNamespace(mountpoint="/dev/shm", fstype="tmpfs"),
            SimpleNamespace(mountpoint="/media", fstype="ext4"),
        ]
        with patch(f"{MOD}.psutil.disk_partitions", return_value=parts):
            self.assertEqual(services.get_fs_type("/dev/shm"), "tmpfs")
            self.assertEqual(services.get_fs_type("/config"), "overlay")

    def test_get_fs_type_no_match(self):
        with patch(f"{MOD}.psutil.disk_partitions", return_value=[]):
            self.assertEqual(services.get_fs_type("/x"), "")

    def _config(self, restream):
        def cam(enabled, width, height):
            return SimpleNamespace(
                enabled_in_config=enabled,
                detect=SimpleNamespace(width=width, height=height),
            )

        return SimpleNamespace(
            birdseye=SimpleNamespace(restream=restream),
            cameras={
                "a": cam(True, 1280, 720),
                "b": cam(False, 1920, 1080),
                "c": cam(True, None, None),
            },
        )

    def test_shm_unavailable(self):
        with patch(f"{MOD}.shm_usage", return_value=None):
            self.assertEqual(
                services.calculate_shm_requirements(self._config(False)), {}
            )

    def test_shm_requirements(self):
        mb = 1 << 20
        usage = ShmUsage(total=256 * mb, used=64 * mb, free=192 * mb)
        with (
            patch(f"{MOD}.shm_usage", return_value=usage),
            patch(f"{MOD}.get_fs_type", return_value="tmpfs"),
            patch.dict(f"{MOD}.os.environ", {SHM_FRAMES_VAR: "50"}),
        ):
            result = services.calculate_shm_requirements(self._config(True))
        # one enabled 720p camera plus two reserved 720p slots, 1.6 MB each
        self.assertAlmostEqual(result.pop("camera_frame_size"), 4.8)
        self.assertEqual(
            result,
            {
                "total": 256.0,
                "used": 64.0,
                "free": 192.0,
                "mount_type": "tmpfs",
                "available": 198.0,
                "shm_frame_count": 41,
                "min_shm": 154,
            },
        )


if __name__ == "__main__":
    unittest.main()
