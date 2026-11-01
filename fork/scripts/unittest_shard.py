"""Run one shard of the backend unittest suite, or check that the shards add up.

`python3 -m unittest` runs the 5,000 frigate tests in one process, which was
most of the backend job's time (I69). fork/scripts/py-checks.sh starts one
container per shard instead, each running

    python3 -m coverage run --parallel-mode fork/scripts/unittest_shard.py \\
        run --index I --count N --manifest /tmp/cov/manifest-I.json

Every shard discovers the whole suite the way `python3 -m unittest` does and
runs every Nth test of it, starting at its index, in discovery order. Dealing
the tests out one by one keeps the shards even although a test's cost varies a
hundredfold (each HTTP API test migrates a fresh database): whole modules made
one shard 3.5 times slower than another. A class's tests stay in their order,
so its fixtures still run once per shard, and the split depends only on the
discovered suite, so a given tree is always split the same way.

Each shard writes a manifest; `check` fails unless every shard discovered the
same suite and ran exactly the tests dealt to it, so that together they ran
each discovered test once. Only then are the coverage files combined.

    python3 fork/scripts/unittest_shard.py check manifest-0.json manifest-1.json
"""

import argparse
import hashlib
import json
import os
import sys
import time
import unittest
import warnings
from collections.abc import Iterator
from pathlib import Path
from typing import Any


def leaves(
    suite: unittest.TestSuite | unittest.TestCase,
) -> Iterator[unittest.TestCase]:
    """Yield every test case inside a (possibly nested) suite, in order."""
    if isinstance(suite, unittest.TestCase):
        yield suite
        return
    for item in suite:
        yield from leaves(item)


def discover(start: str = ".") -> list[unittest.TestCase]:
    """Every test `python3 -m unittest` runs, in the order it runs them.

    Discovery lists directories in sorted order, so every shard sees the same
    tests in the same order. A module that fails to import is one failing test.
    """
    return list(leaves(unittest.TestLoader().discover(start)))


def dealt(total: int, index: int, count: int) -> range:
    """The positions of the tests shard `index` of `count` runs."""
    if count < 1:
        raise ValueError("shard count must be at least 1")
    if not 0 <= index < count:
        raise ValueError(f"shard index {index} is outside 0..{count - 1}")
    return range(index, total, count)


def fingerprint(tests: list[unittest.TestCase]) -> str:
    """A digest of the discovered suite, so shards can prove they agree on it."""
    digest = hashlib.sha256()
    for test in tests:
        digest.update(test.id().encode())
        digest.update(b"\n")
    return digest.hexdigest()


class TimedResult(unittest.TextTestResult):
    """A text result that also records how long each module's tests took."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.module_seconds: dict[str, float] = {}
        self._started = 0.0

    def startTest(self, test: unittest.TestCase) -> None:
        self._started = time.monotonic()
        super().startTest(test)

    def stopTest(self, test: unittest.TestCase) -> None:
        super().stopTest(test)
        module = type(test).__module__
        elapsed = time.monotonic() - self._started
        self.module_seconds[module] = self.module_seconds.get(module, 0.0) + elapsed


def run_shard(index: int, count: int, manifest: Path, start: str = ".") -> int:
    """Run shard `index` of `count` and write its manifest; 0 when it passed."""
    # Import as `python3 -m unittest` does: from the working directory first,
    # not from this script's directory, so a test imports what it would there.
    if sys.path and Path(sys.path[0]).resolve() == Path(__file__).resolve().parent:
        sys.path[0] = os.getcwd()
    tests = discover(start)
    mine = dealt(len(tests), index, count)
    suite = unittest.TestSuite(tests[i] for i in mine)
    runner = unittest.TextTestRunner(resultclass=TimedResult)
    started = time.monotonic()
    with warnings.catch_warnings():
        # The filter `python3 -m unittest` installs when no -W option is given.
        if not sys.warnoptions:
            warnings.simplefilter("default")
        result = runner.run(suite)
    if not isinstance(result, TimedResult):
        raise TypeError("the runner did not use TimedResult")
    slowest = sorted(result.module_seconds.items(), key=lambda kv: -kv[1])[:10]
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(
        json.dumps(
            {
                "index": index,
                "count": count,
                "suite": fingerprint(tests),
                "suite_tests": len(tests),
                "tests": len(mine),
                "ran": result.testsRun,
                "passed": result.wasSuccessful(),
                "seconds": round(time.monotonic() - started, 1),
                "slowest": [[name, round(sec, 1)] for name, sec in slowest],
            },
            indent=1,
        )
    )
    return 0 if result.wasSuccessful() else 1


def check(manifests: list[dict[str, Any]]) -> list[str]:
    """Every reason the shards do not add up to one whole run of the suite."""
    if not manifests:
        return ["no shard manifests"]
    first = manifests[0]
    count, total = first["count"], first["suite_tests"]
    problems = []
    indexes = sorted(m["index"] for m in manifests)
    if indexes != list(range(count)):
        problems.append(f"expected shards 0..{count - 1}, got {indexes}")
    for m in manifests:
        if (m["count"], m["suite"], m["suite_tests"]) != (count, first["suite"], total):
            problems.append(f"shard {m['index']} discovered a different suite")
            continue
        expected = len(dealt(total, m["index"], count))
        if m["tests"] != expected or m["ran"] != expected:
            problems.append(
                f"shard {m['index']} ran {m['ran']} of the {expected} tests dealt to it"
            )
    return problems


def summary(manifests: list[dict[str, Any]]) -> str:
    """One line per shard: its tests, time and slowest modules."""
    lines = []
    for m in sorted(manifests, key=lambda m: m["index"]):
        slow = ", ".join(f"{name} {sec}s" for name, sec in m["slowest"][:3])
        lines.append(
            f"shard {m['index']}: {m['ran']} tests in {m['seconds']}s "
            f"({'ok' if m['passed'] else 'FAILED'}); slowest: {slow}"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="run one shard")
    run.add_argument("--index", type=int, required=True)
    run.add_argument("--count", type=int, required=True)
    run.add_argument("--manifest", type=Path, required=True)
    run.add_argument("--start", default=".", help="discovery start directory")
    verify = commands.add_parser("check", help="check the shards add up")
    verify.add_argument("manifests", type=Path, nargs="+")
    args = parser.parse_args(argv)

    if args.command == "run":
        return run_shard(args.index, args.count, args.manifest, args.start)
    loaded = [json.loads(path.read_text()) for path in args.manifests]
    print(summary(loaded))
    problems = check(loaded)
    for problem in problems:
        print(f"error: {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
