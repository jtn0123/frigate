"""The local release builds, tags and publishes what the workflow would (I164)."""

import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import MagicMock, patch

import release_local
from release_local import Plan, ReleaseError

SHA = "0c76d56b3d3371374b9932450f7ed9f0e878d964"
IMAGE = "ghcr.io/jtn0123/frigate"


def a_plan(released: bool = False, previous: str | None = "fork/0.18.2-1.57") -> Plan:
    version = "0.18.2-20261113.local1"
    return Plan(
        SHA,
        version,
        released,
        IMAGE,
        release_local.image_tags(IMAGE, SHA, version),
        previous,
    )


class TestVersions(unittest.TestCase):
    def test_the_first_local_release_of_a_day_is_local1(self):
        tags = ["fork/0.18.2-20261104.57", "android-v0.2.3"]
        self.assertEqual(
            release_local.next_version("0.18.2", "20261113", tags),
            "0.18.2-20261113.local1",
        )

    def test_a_later_release_that_day_counts_on_from_the_highest(self):
        tags = [
            "fork/0.18.2-20261113.local1",
            "fork/0.18.2-20261113.local3",
            "fork/0.18.2-20261112.local9",
            "fork/0.18.2-20261113.58",
            "fork/0.18.1-20261113.local7",
        ]
        self.assertEqual(
            release_local.next_version("0.18.2", "20261113", tags),
            "0.18.2-20261113.local4",
        )

    def test_a_commit_with_a_release_keeps_its_version(self):
        releases = [
            {
                "tag_name": "android-v0.2.3",
                "draft": False,
                "body": f"fork-build: {SHA} -->",
            },
            {
                "tag_name": "fork/0.18.2-x.1",
                "draft": True,
                "body": f"fork-build: {SHA} -->",
            },
            {
                "tag_name": "fork/0.18.2-x.2",
                "draft": False,
                "body": f"<!-- fork-build: {SHA} -->",
            },
        ]
        self.assertEqual(release_local.released_version(releases, SHA), "0.18.2-x.2")
        self.assertIsNone(release_local.released_version(releases, "f" * 40))

    def test_tags_are_the_workflows_for_main_without_rocm(self):
        self.assertEqual(
            release_local.image_tags(IMAGE, SHA, "v1"),
            [f"{IMAGE}:0c76d56-amd64", f"{IMAGE}:v1", f"{IMAGE}:main"],
        )


class TestPlan(unittest.TestCase):
    def test_a_new_release_takes_the_upstream_base_and_todays_date(self):
        releases = [
            {"tag_name": "fork/0.18.2-20261113.local1", "draft": False, "body": ""}
        ]
        with (
            patch.object(release_local, "fetch_releases", return_value=releases),
            patch.object(release_local, "run", return_value="v0.18.2") as run,
            patch.object(release_local.time, "strftime", return_value="20261113"),
            patch.object(release_local, "list_releases", return_value=[]),
            patch.object(
                release_local, "newest_server_release", return_value="fork/prev"
            ),
        ):
            plan = release_local.plan("jtn0123/Frigate", Path("/repo"), SHA)
        self.assertEqual(plan.version, "0.18.2-20261113.local2")
        self.assertFalse(plan.released)
        self.assertEqual(plan.image, "ghcr.io/jtn0123/frigate")
        self.assertEqual(plan.previous, "fork/prev")
        command = run.call_args.args[0]
        self.assertTrue(command[1].endswith("upstream_base.py"))
        self.assertEqual(command[2:4], ["--ref", SHA])

    def test_a_released_commit_reuses_its_version(self):
        releases = [
            {
                "tag_name": "fork/0.18.2-x.5",
                "draft": False,
                "body": f"fork-build: {SHA} -->",
            }
        ]
        with (
            patch.object(release_local, "fetch_releases", return_value=releases),
            patch.object(release_local, "run") as run,
            patch.object(release_local, "list_releases", return_value=[]),
            patch.object(release_local, "newest_server_release", return_value=None),
        ):
            plan = release_local.plan("jtn0123/frigate", Path("/repo"), SHA)
        run.assert_not_called()
        self.assertTrue(plan.released)
        self.assertEqual(plan.version, "0.18.2-x.5")
        self.assertIn(f"{IMAGE}:0.18.2-x.5", plan.tags)

    def test_releases_are_read_one_json_object_per_line(self):
        lines = '{"tag_name": "a"}\n\n{"tag_name": "b"}\n'
        with patch.object(release_local, "run", return_value=lines) as run:
            releases = release_local.fetch_releases("jtn0123/frigate")
        self.assertEqual([r["tag_name"] for r in releases], ["a", "b"])
        self.assertIn("--paginate", run.call_args.args[0])


class TestRegistryLogin(unittest.TestCase):
    def check(self, content: str | None) -> bool:
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            if content is not None:
                config.write_text(content)
            return release_local.has_registry_login(config)

    def test_a_ghcr_entry_counts_however_it_is_written(self):
        for data in (
            {"auths": {"ghcr.io": {}}},
            {"auths": {"https://ghcr.io/": {}}},
            {"credHelpers": {"ghcr.io": "desktop"}},
        ):
            self.assertTrue(self.check(json.dumps(data)), data)

    def test_no_ghcr_entry_or_no_readable_config_is_no_login(self):
        self.assertFalse(self.check(json.dumps({"auths": {"docker.io": {}}})))
        self.assertFalse(self.check("{not json"))
        self.assertFalse(self.check(None))


class TestPreflightAndBuilder(unittest.TestCase):
    def test_docker_must_be_running(self):
        with patch.object(
            release_local.subprocess, "run", return_value=MagicMock(returncode=1)
        ):
            with self.assertRaisesRegex(ReleaseError, "colima start"):
                release_local.preflight(Path("/nonexistent/config.json"))

    def test_a_missing_login_names_the_owners_steps(self):
        with (
            patch.object(
                release_local.subprocess, "run", return_value=MagicMock(returncode=0)
            ),
            patch.object(release_local, "has_registry_login", return_value=False),
        ):
            with self.assertRaisesRegex(ReleaseError, "docker login ghcr.io"):
                release_local.preflight(Path("/nonexistent/config.json"))

    def test_a_missing_builder_is_created_with_the_workflows_parallelism(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(
                release_local.subprocess, "run", return_value=MagicMock(returncode=1)
            ),
            patch.object(
                release_local, "run", return_value="Platforms: linux/arm64, linux/amd64"
            ) as run,
        ):
            release_local.ensure_builder(Path(directory))
            config = (Path(directory) / "buildkitd.toml").read_text()
        self.assertIn("max-parallelism = 2", config)
        create = run.call_args_list[0].args[0]
        self.assertEqual(create[:3], ["docker", "buildx", "create"])
        self.assertIn("docker-container", create)

    def test_a_builder_without_amd64_says_how_to_register_it(self):
        with (
            patch.object(
                release_local.subprocess, "run", return_value=MagicMock(returncode=0)
            ),
            patch.object(release_local, "run", return_value="Platforms: linux/arm64"),
        ):
            with self.assertRaisesRegex(ReleaseError, "tonistiigi/binfmt"):
                release_local.ensure_builder(Path("/unused"))


class TestSteps(unittest.TestCase):
    def test_checkout_adds_the_worktree_once_then_resets_it_to_the_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            worktree = Path(directory) / "release"
            with patch.object(release_local, "run") as run:
                release_local.checkout(Path("/repo"), worktree, SHA)
        commands = [c.args[0] for c in run.call_args_list]
        self.assertEqual(commands[0][:4], ["git", "worktree", "add", "--detach"])
        self.assertEqual(
            commands[1:],
            [
                ["git", "checkout", "--detach", "--force", SHA],
                ["git", "clean", "-ffdxq"],
                ["make", "version"],
            ],
        )

    def test_build_pushes_amd64_only_and_always_releases_the_lock(self):
        failure = subprocess.CalledProcessError(1, "bake")
        with (
            patch.object(release_local, "take") as take,
            patch.object(release_local.os, "rmdir") as rmdir,
            patch.object(release_local.subprocess, "run", side_effect=failure) as run,
        ):
            with self.assertRaises(subprocess.CalledProcessError):
                release_local.build(a_plan(), Path("/src"), Path("/out"), False)
        take.assert_called_once_with(release_local.DOCKER_LOCK)
        rmdir.assert_called_once_with(release_local.DOCKER_LOCK)
        command = run.call_args.args[0]
        self.assertNotIn("--rocm-tags", command)
        self.assertNotIn("--rebuild-dependencies", command)
        self.assertEqual(
            command[command.index("--amd64-tags") + 1], ",".join(a_plan().tags)
        )
        self.assertEqual(command[command.index("--builder") + 1], "frigate-release")

    def test_publish_writes_the_notes_and_creates_the_latest_release(self):
        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(release_local, "run", return_value="notes") as run,
        ):
            release_local.publish(
                "jtn0123/frigate", a_plan(), Path("/repo"), Path(directory)
            )
            notes = (Path(directory) / "notes.md").read_text()
        self.assertEqual(notes, "notes\n")
        notes_command, create = (c.args[0] for c in run.call_args_list)
        self.assertEqual(
            notes_command[notes_command.index("--previous") + 1], "fork/0.18.2-1.57"
        )
        self.assertIn(f"{IMAGE}:0.18.2-20261113.local1", notes_command)
        self.assertEqual(
            create[:4], ["gh", "release", "create", "fork/0.18.2-20261113.local1"]
        )
        self.assertEqual(create[create.index("--target") + 1], SHA)
        self.assertIn("--latest", create)


class TestMain(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        env = patch.dict(
            os.environ,
            {
                "FORK_RELEASE_HOME": directory.name,
                "FORK_RELEASE_WORKTREE": str(Path(directory.name) / "release"),
            },
        )
        env.start()
        self.addCleanup(env.stop)
        self.steps = MagicMock()
        for name in ("preflight", "ensure_builder", "checkout", "build", "publish"):
            patcher = patch.object(release_local, name, getattr(self.steps, name))
            patcher.start()
            self.addCleanup(patcher.stop)
        git = patch.object(release_local, "run", side_effect=self.git)
        git.start()
        self.addCleanup(git.stop)

    @staticmethod
    def git(command, cwd=None):
        if command[:2] == ["git", "rev-parse"]:
            return (
                "/repo/.git"
                if "--git-common-dir" in command
                else (SHA if command[-1] == "origin/main" else "/repo")
            )
        return ""

    def main(self, plan: Plan, *argv: str) -> int:
        self.output = io.StringIO()
        with (
            patch.object(release_local, "plan", return_value=plan),
            redirect_stdout(self.output),
            redirect_stderr(self.output),
        ):
            return release_local.main(list(argv))

    def called(self) -> list[str]:
        return [name for name, _args, _kwargs in self.steps.mock_calls]

    def test_a_dry_run_only_prints_the_plan(self):
        self.assertEqual(self.main(a_plan(), "--dry-run"), 0)
        self.assertEqual(self.called(), [])
        self.assertIn(f"{IMAGE}:main", self.output.getvalue())

    def test_a_release_checks_first_then_builds_then_publishes(self):
        self.assertEqual(self.main(a_plan()), 0)
        self.assertEqual(
            self.called(),
            ["preflight", "ensure_builder", "checkout", "build", "publish"],
        )
        self.assertEqual(self.steps.checkout.call_args.args[2], SHA)

    def test_a_released_commit_is_rebuilt_but_not_released_again(self):
        self.assertEqual(self.main(a_plan(released=True)), 0)
        self.assertNotIn("publish", self.called())
        self.assertIn("build", self.called())
        self.assertIn("not publishing it again", self.output.getvalue())

    def test_a_failed_check_stops_before_the_build(self):
        self.steps.preflight.side_effect = ReleaseError("not signed in")
        self.assertEqual(self.main(a_plan()), 1)
        self.assertEqual(self.called(), ["preflight"])
        self.assertIn("release-local: not signed in", self.output.getvalue())

    def test_a_failed_build_publishes_nothing(self):
        self.steps.build.side_effect = subprocess.CalledProcessError(1, "bake")
        self.assertEqual(self.main(a_plan()), 1)
        self.assertNotIn("publish", self.called())

    def test_rebuilding_dependencies_is_passed_to_the_build(self):
        self.main(a_plan(), "--rebuild-dependencies")
        self.assertTrue(self.steps.build.call_args.args[3])


if __name__ == "__main__":
    unittest.main()
