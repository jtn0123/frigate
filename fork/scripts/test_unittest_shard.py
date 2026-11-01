"""unittest_shard.py must split the suite so the shards add up to one run."""

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "unittest_shard", Path(__file__).with_name("unittest_shard.py")
)
assert SPEC and SPEC.loader
shard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(shard)

PASSING = """import unittest


class T(unittest.TestCase):
{tests}
"""


class SyntheticSuite:
    """A throwaway package of test modules, removed from sys.path afterwards."""

    def __init__(self, modules: dict[str, str]) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        # A unique package name, so modules never collide in sys.modules.
        self.package = "synthetic_" + uuid.uuid4().hex[:8]
        package = self.root / self.package
        package.mkdir()
        (package / "__init__.py").write_text("")
        for name, body in modules.items():
            (package / f"{name}.py").write_text(body)
        self.saved_path = list(sys.path)

    def close(self) -> None:
        sys.path[:] = self.saved_path
        for name in [m for m in sys.modules if m.startswith(self.package)]:
            del sys.modules[name]
        self.directory.cleanup()


def passing(count: int) -> str:
    tests = "\n".join(f"    def test_{i}(self):\n        pass\n" for i in range(count))
    return PASSING.format(tests=tests)


class TestDealt(unittest.TestCase):
    def test_the_shards_take_every_test_once(self):
        positions = [i for index in range(3) for i in shard.dealt(10, index, 3)]
        self.assertEqual(sorted(positions), list(range(10)))

    def test_the_tests_are_dealt_one_by_one(self):
        self.assertEqual(list(shard.dealt(7, 1, 3)), [1, 4])
        self.assertEqual(list(shard.dealt(7, 0, 3)), [0, 3, 6])

    def test_one_shard_takes_everything(self):
        self.assertEqual(list(shard.dealt(3, 0, 1)), [0, 1, 2])

    def test_more_shards_than_tests_leaves_some_empty(self):
        self.assertEqual(list(shard.dealt(1, 2, 3)), [])

    def test_zero_shards_is_refused(self):
        with self.assertRaises(ValueError):
            shard.dealt(1, 0, 0)

    def test_an_index_outside_the_shards_is_refused(self):
        with self.assertRaises(ValueError):
            shard.dealt(4, 2, 2)


def manifest(index: int, count: int, **extra) -> dict:
    """A shard's manifest that ran `count` tests, with `extra` overriding."""
    data = {
        "index": index,
        "count": 2,
        "suite": "abc",
        "suite_tests": 5,
        "tests": count,
        "ran": count,
        "passed": True,
        "seconds": 1.0,
        "slowest": [["a", 0.5]],
    }
    data.update(extra)
    return data


class TestCheck(unittest.TestCase):
    def test_shards_that_add_up_pass(self):
        self.assertEqual(shard.check([manifest(0, 3), manifest(1, 2)]), [])

    def test_no_manifests_fail(self):
        self.assertEqual(shard.check([]), ["no shard manifests"])

    def test_a_missing_shard_fails(self):
        self.assertEqual(
            shard.check([manifest(0, 3)]), ["expected shards 0..1, got [0]"]
        )

    def test_a_shard_counted_twice_fails(self):
        problems = shard.check([manifest(0, 3), manifest(0, 3)])
        self.assertIn("expected shards 0..1, got [0, 0]", problems)

    def test_a_different_suite_fails(self):
        problems = shard.check([manifest(0, 3), manifest(1, 2, suite="xyz")])
        self.assertEqual(problems, ["shard 1 discovered a different suite"])

    def test_tests_that_did_not_run_fail(self):
        problems = shard.check([manifest(0, 3), manifest(1, 2, tests=2, ran=1)])
        self.assertEqual(problems, ["shard 1 ran 1 of the 2 tests dealt to it"])

    def test_the_summary_names_each_shard(self):
        text = shard.summary([manifest(1, 2, passed=False), manifest(0, 3)])
        self.assertEqual(
            text.splitlines(),
            [
                "shard 0: 3 tests in 1.0s (ok); slowest: a 0.5s",
                "shard 1: 2 tests in 1.0s (FAILED); slowest: a 0.5s",
            ],
        )


class TestRunShards(unittest.TestCase):
    def setUp(self):
        self.suite = SyntheticSuite(
            {
                "test_big": passing(4),
                "test_small": passing(1),
                "test_mid": passing(2),
                "test_empty": "x = 1\n",
                "helper": "raise RuntimeError('not a test module')\n",
            }
        )
        self.addCleanup(self.suite.close)

    def run_all(self, count: int) -> tuple[list[int], list[Path]]:
        codes, paths = [], []
        for index in range(count):
            path = self.suite.root / "out" / f"manifest-{index}.json"
            with contextlib.redirect_stderr(io.StringIO()):
                codes.append(shard.run_shard(index, count, path, str(self.suite.root)))
            paths.append(path)
        return codes, paths

    def test_discovery_finds_what_unittest_runs_in_its_order(self):
        tests = shard.discover(str(self.suite.root))
        expected = unittest.TestLoader().discover(str(self.suite.root))
        self.assertEqual(
            [t.id() for t in tests], [t.id() for t in shard.leaves(expected)]
        )
        modules = [type(t).__module__.rsplit(".", 1)[-1] for t in tests]
        self.assertEqual(modules, ["test_big"] * 4 + ["test_mid"] * 2 + ["test_small"])

    def test_the_shards_together_run_the_whole_suite(self):
        codes, paths = self.run_all(2)
        self.assertEqual(codes, [0, 0])
        loaded = [json.loads(path.read_text()) for path in paths]
        self.assertEqual(shard.check(loaded), [])
        self.assertEqual([m["ran"] for m in loaded], [4, 3])
        self.assertEqual(loaded[0]["tests"], 4)
        self.assertEqual(loaded[0]["suite"], loaded[1]["suite"])
        self.assertEqual(loaded[0]["suite_tests"], 7)
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(shard.main(["check", *map(str, paths)]), 0)
        self.assertIn("shard 1: 3 tests", out.getvalue())

    def test_a_failing_test_fails_its_shard_only(self):
        failing = self.suite.root / self.suite.package / "test_broken.py"
        failing.write_text(
            "import unittest\n\n\nclass T(unittest.TestCase):\n"
            "    def test_it(self):\n        self.fail('broken')\n"
        )
        codes, paths = self.run_all(2)
        self.assertEqual(sorted(codes), [0, 1])
        loaded = [json.loads(path.read_text()) for path in paths]
        self.assertEqual(shard.check(loaded), [])
        self.assertEqual(sorted(m["passed"] for m in loaded), [False, True])

    def test_a_module_that_fails_to_import_still_counts_and_fails(self):
        broken = self.suite.root / self.suite.package / "test_import.py"
        broken.write_text("import does_not_exist_anywhere\n")
        codes, paths = self.run_all(1)
        self.assertEqual(codes, [1])
        loaded = json.loads(paths[0].read_text())
        self.assertEqual(loaded["ran"], loaded["suite_tests"])
        self.assertEqual(loaded["suite_tests"], 8)

    def test_check_fails_when_a_manifest_is_missing(self):
        _, paths = self.run_all(2)
        with (
            contextlib.redirect_stdout(io.StringIO()),
            contextlib.redirect_stderr(io.StringIO()) as err,
        ):
            self.assertEqual(shard.main(["check", str(paths[0])]), 1)
        self.assertIn("expected shards 0..1", err.getvalue())

    def test_main_runs_one_shard(self):
        path = self.suite.root / "manifest.json"
        argv = ["run", "--index", "0", "--count", "1", "--manifest", str(path)]
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(shard.main([*argv, "--start", str(self.suite.root)]), 0)
        self.assertEqual(json.loads(path.read_text())["ran"], 7)

    def test_class_fixtures_run_once_per_shard(self):
        fixture = self.suite.root / self.suite.package / "test_fixture.py"
        tests = "".join(f"    def test_{i}(self):\n        pass\n\n" for i in range(4))
        fixture.write_text(
            "import unittest\n\n\nclass T(unittest.TestCase):\n"
            "    calls = 0\n\n"
            "    @classmethod\n    def setUpClass(cls):\n        T.calls += 1\n\n"
            + tests
        )
        codes, _ = self.run_all(2)
        self.assertEqual(codes, [0, 0])
        # Both shards ran in this process, so the class saw one setup each.
        module = sys.modules[f"{self.suite.package}.test_fixture"]
        self.assertEqual(module.T.calls, 2)


if __name__ == "__main__":
    unittest.main()
