"""Run on the Proxmox host to publish scoped, credential-free resource readings."""

import argparse
import json
import os
import subprocess
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

CGROUP = Path("/sys/fs/cgroup")
MAX_HOST_PROCESSES = 8192
MAX_SERVICE_PROCESSES = 4096
MAX_SERVICE_GROUPS = 128


def kernel_text(path: Path, maximum: int = 65536) -> str:
    """Read a bounded kernel counter or process identity file."""
    with path.open() as source:
        text = source.read(maximum + 1)
    if len(text) > maximum:
        raise ValueError("Kernel measurement exceeds collection bound")
    return text


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
        for line in kernel_text(Path(f"/proc/{pid}/cgroup"), 4096).splitlines()
        if line.startswith("0::")
    )
    if not entry.startswith("/") or ".." in Path(entry).parts:
        raise ValueError("Invalid unified cgroup path")
    return CGROUP / entry.lstrip("/")


def process_identity(pid: int) -> tuple[int, int]:
    """Read start ticks and RSS without opening process arguments or environments."""
    raw = kernel_text(Path(f"/proc/{pid}/stat"), 4096)
    if raw.split(" ", 1)[0] != str(pid):
        raise ValueError("Process identity changed")
    fields = raw.rsplit(")", 1)[1].split()
    start, pages = int(fields[19]), int(fields[21])
    if start < 0 or pages < 0:
        raise ValueError("Invalid process counters")
    return start, pages * os.sysconf("SC_PAGE_SIZE")


def namespace_pids(pid: int) -> list[int]:
    """Read PID namespace identities in host-to-container order."""
    line = next(
        line
        for line in kernel_text(Path(f"/proc/{pid}/status"), 16384).splitlines()
        if line.startswith("NSpid:")
    )
    pids = [int(value) for value in line.split()[1:]]
    if not pids or pids[0] != pid or any(value <= 0 for value in pids):
        raise ValueError("Invalid process namespace identity")
    return pids


def service_main(
    group: Path, control_group: Path, main_pid: int, depth: int
) -> tuple[int, int, Path]:
    """Resolve a CT service PID and cgroup to the host's namespace."""
    service_parts = control_group.parts[1:]
    for count, proc in enumerate(Path("/proc").glob("[0-9]*"), 1):
        if count > MAX_HOST_PROCESSES:
            raise ValueError("Host process scan exceeds collection bound")
        try:
            pid = int(proc.name)
            before, _ = process_identity(pid)
            process_group = group_for(pid)
            if group not in process_group.parents:
                continue
            service = next(
                ancestor
                for ancestor in (process_group, *process_group.parents)
                if ancestor.parts[-len(service_parts) :] == service_parts
                and group in ancestor.parents
            )
            pids = namespace_pids(pid)
            if len(pids) != depth or pids[depth - 1] != main_pid:
                continue
            after, _ = process_identity(pid)
            if before != after or group_for(pid) != process_group:
                raise ValueError("Service process identity changed")
            return pid, before, service
        except (FileNotFoundError, ProcessLookupError, PermissionError, StopIteration):
            continue
    raise ValueError("Ollama service main process unavailable")


def add_service_pids(group: Path, pids: set[int]) -> None:
    """Add unique service PIDs without exceeding the shared collection bound."""
    for value in kernel_text(group / "cgroup.procs").split():
        pid = int(value)
        if pid <= 0:
            raise ValueError("Invalid service process ID")
        pids.add(pid)
        if len(pids) > MAX_SERVICE_PROCESSES:
            raise ValueError("Service process count exceeds collection bound")


def service_children(group: Path) -> Iterator[Path]:
    """Yield child cgroups while rejecting redirected kernel paths."""
    for child in group.iterdir():
        if child.is_symlink():
            raise ValueError("Unexpected service cgroup symlink")
        if child.is_dir():
            yield child


def service_members(group: Path) -> set[int]:
    """Collect unique host PIDs from a bounded service cgroup subtree."""
    pending = [group]
    seen: set[Path] = set()
    pids: set[int] = set()
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        if len(seen) > MAX_SERVICE_GROUPS:
            raise ValueError("Service cgroup scan exceeds collection bound")
        add_service_pids(current, pids)
        for child in service_children(current):
            pending.append(child)
            if len(pending) + len(seen) > MAX_SERVICE_GROUPS:
                raise ValueError("Service cgroup scan exceeds collection bound")
    return pids


def ollama_service_identity(ct: str) -> tuple[int, Path] | None:
    """Read and validate the container's active Ollama service properties."""
    if not ct.isdecimal() or not 100 <= int(ct) <= 999999999:
        raise ValueError("Container ID must be a positive Proxmox numeric ID")
    raw = subprocess.check_output(
        [
            "pct",
            "exec",
            ct,
            "--",
            "systemctl",
            "show",
            "ollama.service",
            "--property=ActiveState,MainPID,ControlGroup",
        ],
        text=True,
        timeout=5,
    )
    if len(raw) > 4096:
        raise ValueError("Service identity exceeds collection bound")
    state = {
        key: value
        for key, value in (
            line.split("=", 1) for line in raw.splitlines() if "=" in line
        )
    }
    if state.get("ActiveState") in {"inactive", "failed"}:
        return None
    control_group = Path(state.get("ControlGroup", ""))
    main_pid = int(state.get("MainPID", "0"))
    if (
        state.get("ActiveState") != "active"
        or main_pid <= 0
        or not control_group.is_absolute()
        or control_group.name != "ollama.service"
        or ".." in control_group.parts
    ):
        raise ValueError("Ollama service identity unavailable")
    return main_pid, control_group


def service_memory(
    service: Path, members: set[int]
) -> tuple[int, dict[int, tuple[int, Path]]]:
    """Sum verified worker RSS and retain identities for a consistency recheck."""
    rss = 0
    identities = {}
    for member in members:
        identity, memory = process_identity(member)
        member_group = group_for(member)
        if member_group != service and service not in member_group.parents:
            raise ValueError("Process left Ollama service cgroup")
        identities[member] = identity, member_group
        rss += memory
    return rss, identities


def collect_ollama(
    group: Path, ct: str, cpu: Callable[[str, float], float | None]
) -> list[dict[str, Any]]:
    """Measure the verified Ollama service and workers, independent of their names."""
    service_identity = ollama_service_identity(ct)
    if service_identity is None:
        return []
    main_pid, control_group = service_identity
    container_pid = init_pid(ct)
    container_start, _ = process_identity(container_pid)
    container_group = group_for(container_pid)
    if container_group != group and group not in container_group.parents:
        raise ValueError("Container process outside requested cgroup")
    container_pids = namespace_pids(container_pid)
    if container_pids[-1] != 1:
        raise ValueError("Container init namespace identity unavailable")
    pid, start, service = service_main(
        group, control_group, main_pid, len(container_pids)
    )
    members = service_members(service)
    if pid not in members:
        raise ValueError("Ollama main process left service cgroup")
    rss, identities = service_memory(service, members)
    seconds = values(service / "cpu.stat")["usage_usec"] / 1000000
    if seconds < 0:
        raise ValueError("Invalid service CPU counter")
    for member, (identity, member_group) in identities.items():
        if process_identity(member)[0] != identity or group_for(member) != member_group:
            raise ValueError("Ollama process identity changed during collection")
    if (
        process_identity(pid)[0] != start
        or process_identity(container_pid)[0] != container_start
    ):
        raise ValueError("Service or container restarted during collection")
    if service_members(service) != members:
        raise ValueError("Ollama service membership changed during collection")
    return [
        {
            "scope": "ollama",
            "id": ct,
            "memory_bytes": rss,
            "cpu_percent": cpu(f"ollama:{ct}:{pid}:{start}", seconds),
        }
    ]


def collect_container(
    ct: str, cpu: Callable[[str, float], float | None]
) -> tuple[Path, dict[str, Any]]:
    """Measure one verified container cgroup and its effective limits."""
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
        "cpu_percent": cpu(ct, values(group / "cpu.stat")["usage_usec"] / 1000000),
        "oom_kills": values(group / "memory.events").get("oom_kill"),
        "disk_free_bytes": disk.f_bavail * disk.f_frsize,
        "disk_total_bytes": disk.f_blocks * disk.f_frsize,
    }
    for kind in ("cpu", "memory", "io"):
        row[kind + "_pressure"] = pressure(group / (kind + ".pressure"))
    return group, row


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
    scopes: list[dict[str, Any]] = [host]
    incomplete = False
    for ct in cts:
        try:
            group, row = collect_container(ct, cpu)
            scopes.append(row)
            try:
                scopes.extend(collect_ollama(group, ct, cpu))
            except (
                OSError,
                ValueError,
                KeyError,
                StopIteration,
                IndexError,
                subprocess.SubprocessError,
            ):
                incomplete = True
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
        if not incomplete
        and all(
            any(row["scope"] == "container" and row["id"] == ct for row in scopes)
            for ct in cts
        )
        else "partial",
    }


def publish_snapshot(
    root: Path, data: dict, filename: str = "server-telemetry.json"
) -> None:
    """Write into the CT without following container-controlled symlinks as host root."""
    if filename not in {"server-telemetry.json", "stability.json"}:
        raise ValueError("Unsupported telemetry filename")
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
            filename,
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
