"""Run on the Proxmox host to publish scoped, credential-free resource readings."""

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

CGROUP = Path("/sys/fs/cgroup")


def values(path: Path) -> dict[str, int]:
    """Read a two-column kernel counter file."""
    return {
        key: int(value)
        for key, value in (line.split()[:2] for line in path.read_text().splitlines())
    }


def pressure(path: Path) -> float | None:
    """Read the ten-second average of stalled time without inventing missing data."""
    try:
        line = next(
            line for line in path.read_text().splitlines() if line.startswith("some ")
        )
        return float(
            next(
                pair.removeprefix("avg10=")
                for pair in line.split()[1:]
                if pair.startswith("avg10=")
            )
        )
    except (OSError, ValueError, StopIteration, KeyError):
        return None


def limit(path: Path) -> int | None:
    """Read a finite kernel limit, preserving unlimited as unknown."""
    try:
        text = path.read_text().strip()
        return None if text == "max" else int(text)
    except (OSError, ValueError):
        return None


def effective_limits(group: Path) -> tuple[int | None, float | None]:
    """Include ancestor memory and CPU quotas, not just the inner cgroup."""
    memory, cpu = [], []
    for path in [group, *group.parents]:
        if path != CGROUP and CGROUP not in path.parents:
            continue
        size = limit(path / "memory.max")
        if size is not None:
            memory.append(size)
        try:
            quota, period = (path / "cpu.max").read_text().split()
            if quota != "max":
                cpu.append(int(quota) / int(period))
            cpuset = (path / "cpuset.cpus.effective").read_text().strip()
            count = sum(
                int(part.split("-")[-1]) - int(part.split("-")[0]) + 1
                for part in cpuset.split(",")
                if part
            )
            if count:
                cpu.append(count)
        except (OSError, ValueError, ZeroDivisionError):
            pass
    return min(memory) if memory else None, min(cpu) if cpu else None


def init_pid(ct: str) -> int:
    """Ask local LXC tooling for the container init PID without a network token."""
    if not ct.isdecimal() or not 100 <= int(ct) <= 999999999:
        raise ValueError("Container ID must be a positive Proxmox numeric ID")
    return int(
        subprocess.check_output(
            ["lxc-info", "-n", ct, "-pH"], text=True, timeout=5
        ).strip()
    )


def group_for(pid: int) -> Path:
    """Resolve the host-visible unified cgroup for a process."""
    entry = next(
        line[3:]
        for line in Path(f"/proc/{pid}/cgroup").read_text().splitlines()
        if line.startswith("0::")
    )
    return CGROUP / entry.lstrip("/")


def collect_ollama(group: Path, ct: str, cpu, hz: int) -> list[dict]:
    """Measure matching Ollama processes only within the requested cgroup."""
    scopes = []
    rss, seconds, found = 0, 0.0, False
    for proc in Path("/proc").glob("[0-9]*"):
        try:
            if "ollama" not in (proc / "comm").read_text().lower():
                continue
            process_group = group_for(int(proc.name))
            if process_group != group and group not in process_group.parents:
                continue
            stat = (proc / "stat").read_text().rsplit(")", 1)[1].split()
            rss += int(stat[21]) * os.sysconf("SC_PAGE_SIZE")
            seconds += (int(stat[11]) + int(stat[12])) / hz
            found = True
        except (OSError, ValueError, StopIteration, IndexError):
            continue
    if found:
        scopes.append(
            {
                "scope": "ollama",
                "id": ct,
                "memory_bytes": rss,
                "cpu_percent": cpu("ollama:" + ct, seconds),
            }
        )
    return scopes


def sample(cts: list[str], previous: dict) -> dict:
    """Collect host and container counters; unavailable scopes remain absent."""
    now = time.time()
    duration = now - previous.get("updated", now)
    counters = {}

    def cpu(key: str, seconds: float) -> float | None:
        counters[key] = seconds
        before = previous.get("counters", {}).get(key)
        return (
            max(0, (seconds - before) / duration * 100)
            if before is not None and duration > 0 and seconds >= before
            else None
        )

    mem = {
        key.rstrip(":"): int(parts[0]) * 1024
        for key, *parts in (
            line.split() for line in Path("/proc/meminfo").read_text().splitlines()
        )
    }
    ticks = list(map(int, Path("/proc/stat").read_text().splitlines()[0].split()[1:]))
    hz = os.sysconf("SC_CLK_TCK")
    host = {
        "scope": "host",
        "id": os.uname().nodename,
        "memory_bytes": mem["MemTotal"] - mem["MemAvailable"],
        "memory_limit_bytes": mem["MemTotal"],
        "swap_bytes": mem["SwapTotal"] - mem["SwapFree"],
        "swap_limit_bytes": mem["SwapTotal"],
        "cpu_percent": cpu("host", sum(ticks[i] for i in (0, 1, 2, 5, 6, 7)) / hz),
        "cpu_limit": os.cpu_count(),
        "oom_kills": values(Path("/proc/vmstat")).get("oom_kill"),
    }
    for kind in ("cpu", "memory", "io"):
        host[kind + "_pressure"] = pressure(Path("/proc/pressure") / kind)
    disk = os.statvfs("/")
    host.update(
        disk_free_bytes=disk.f_bavail * disk.f_frsize,
        disk_total_bytes=disk.f_blocks * disk.f_frsize,
    )
    scopes = [host]
    for ct in cts:
        try:
            pid = init_pid(ct)
            process_group = group_for(pid)
            group = CGROUP / "lxc" / ct
            if group != process_group and group not in process_group.parents:
                raise ValueError("Container cgroup layout unavailable")
            memory, cores = effective_limits(group)
            disk = os.statvfs(f"/proc/{pid}/root")
            row = {
                "scope": "container",
                "id": ct,
                "memory_bytes": limit(group / "memory.current"),
                "memory_limit_bytes": memory,
                "cpu_limit": cores,
                "swap_bytes": limit(group / "memory.swap.current"),
                "swap_limit_bytes": limit(group / "memory.swap.max"),
                "cpu_percent": cpu(
                    ct, values(group / "cpu.stat")["usage_usec"] / 1000000
                ),
                "oom_kills": values(group / "memory.events").get("oom_kill"),
                "disk_free_bytes": disk.f_bavail * disk.f_frsize,
                "disk_total_bytes": disk.f_blocks * disk.f_frsize,
            }
            for kind in ("cpu", "memory", "io"):
                row[kind + "_pressure"] = pressure(group / (kind + ".pressure"))
            scopes.append(row)
            scopes.extend(collect_ollama(group, ct, cpu, hz))
        except (
            OSError,
            ValueError,
            KeyError,
            StopIteration,
            subprocess.SubprocessError,
        ):
            # Do not publish zeros when a container cannot be measured.
            continue
    return {
        "updated": now,
        "scopes": scopes,
        "counters": counters,
        "status": "connected"
        if all(
            any(row["scope"] == "container" and row["id"] == ct for row in scopes)
            for ct in cts
        )
        else "partial",
    }


def publish_snapshot(root: Path, data: dict) -> None:
    """Write into the CT without following container-controlled symlinks as host root."""
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    temporary = f".server-telemetry-{os.getpid()}.tmp"
    created = False
    try:
        for part in ("opt", "frigate", "config", "model_cache"):
            child = os.open(
                part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory
            )
            os.close(directory)
            directory = child
        file = os.open(
            temporary,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o644,
            dir_fd=directory,
        )
        created = True
        with os.fdopen(file, "w") as output:
            json.dump(data, output)
        os.replace(
            temporary,
            "server-telemetry.json",
            src_dir_fd=directory,
            dst_dir_fd=directory,
        )
        created = False
    finally:
        if created:
            os.unlink(temporary, dir_fd=directory)
        os.close(directory)


def main() -> None:
    """Publish atomically to Frigate's local config mount; no listener or token."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--containers", nargs="+", default=["106", "108"])
    parser.add_argument("--frigate", default="106")
    parser.add_argument(
        "--state", type=Path, default=Path("/run/frigate-monitoring.json")
    )
    args = parser.parse_args()
    try:
        previous = json.loads(args.state.read_text()) if args.state.exists() else {}
        if not isinstance(previous, dict):
            previous = {}
    except (OSError, ValueError):
        previous = {}
    data = sample(args.containers, previous)
    state_temporary = args.state.with_suffix(".tmp")
    state_temporary.write_text(json.dumps(data))
    state_temporary.replace(args.state)
    publish_snapshot(
        Path(f"/proc/{init_pid(args.frigate)}/root"),
        {key: value for key, value in data.items() if key != "counters"},
    )


if __name__ == "__main__":
    main()
