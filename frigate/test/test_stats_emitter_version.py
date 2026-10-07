"""Tests for the daily latest version refresh and the update notice."""

import unittest
from unittest.mock import MagicMock, patch

from frigate.stats import emitter
from frigate.stats.util import is_fork_release, is_newer_version


class TestIsNewerVersion(unittest.TestCase):
    def test_newer(self):
        self.assertTrue(is_newer_version("0.18.1-abcdef", "0.19.0"))
        self.assertTrue(is_newer_version("0.19.0-abcdef", "0.19.1"))
        self.assertTrue(is_newer_version("0.19.0-abcdef", "1.0.0"))

    def test_not_newer(self):
        self.assertFalse(is_newer_version("0.19.0-abcdef", "0.19.0"))
        self.assertFalse(is_newer_version("0.19.1-abcdef", "0.19.0"))
        self.assertFalse(is_newer_version("0.19.0-abcdef", "0.19.0-beta2"))

    def test_prerelease_is_behind_its_final_release(self):
        self.assertTrue(is_newer_version("0.19.0-beta2", "0.19.0"))
        self.assertTrue(is_newer_version("0.19.0-rc1", "0.19.0"))
        self.assertTrue(is_newer_version("0.19.0-RC1", "0.19.0"))

    def test_prerelease_of_a_later_line_is_not_behind(self):
        self.assertFalse(is_newer_version("0.20.0-beta1", "0.19.0"))
        self.assertFalse(is_newer_version("0.19.0-beta2", "0.19.0-beta2"))

    def test_unparseable_is_never_newer(self):
        self.assertFalse(is_newer_version("0.19.0-abcdef", "disabled"))
        self.assertFalse(is_newer_version("0.19.0-abcdef", "unknown"))
        self.assertFalse(is_newer_version("dev", "0.19.0"))


class TestIsForkRelease(unittest.TestCase):
    def test_fork_tags(self):
        self.assertTrue(is_fork_release("0.18.0-20260924.48"))
        self.assertTrue(is_fork_release("0.18.0-rc2-20260912.39"))

    def test_other_versions(self):
        for value in ("0.19.0", "0.19.0-beta2", "0.18.0-abcdef1", "unknown", ""):
            with self.subTest(value=value):
                self.assertFalse(is_fork_release(value))


class TestUpdateNotice(unittest.TestCase):
    def setUp(self):
        raise_patch = patch.object(emitter, "raise_notice")
        resolve_patch = patch.object(emitter, "resolve_kind")
        self.raise_notice = raise_patch.start()
        self.resolve_kind = resolve_patch.start()
        self.addCleanup(raise_patch.stop)
        self.addCleanup(resolve_patch.stop)

    def _emitter(self, latest: str) -> emitter.StatsEmitter:
        stats_emitter = emitter.StatsEmitter.__new__(emitter.StatsEmitter)
        stats_emitter.config = MagicMock()
        stats_emitter.stats_tracking = {"latest_frigate_version": latest}
        return stats_emitter

    def test_newer_release_raises(self):
        with patch.object(emitter, "VERSION", "0.18.1-abcdef"):
            self._emitter("0.19.0")._check_update_notice()

        self.raise_notice.assert_called_once_with(
            "update_available", scope="0.19.0", params={"version": "0.19.0"}
        )
        self.resolve_kind.assert_not_called()

    def test_current_or_disabled_resolves(self):
        for latest in ("0.18.1", "disabled"):
            with self.subTest(latest=latest):
                self.resolve_kind.reset_mock()

                with patch.object(emitter, "VERSION", "0.18.1-abcdef"):
                    self._emitter(latest)._check_update_notice()

                self.raise_notice.assert_not_called()
                self.resolve_kind.assert_called_once_with("update_available")

    def test_a_failed_lookup_leaves_the_notice_alone(self):
        with patch.object(emitter, "VERSION", "0.18.1-abcdef"):
            self._emitter("unknown")._check_update_notice()

        self.raise_notice.assert_not_called()
        self.resolve_kind.assert_not_called()

    def test_refresh_updates_tracking_on_a_thread_then_checks(self):
        stats_emitter = self._emitter("0.18.0")

        with (
            patch.object(emitter, "get_latest_version", return_value="0.19.0"),
            patch.object(emitter, "VERSION", "0.18.1-abcdef"),
            patch.object(emitter.threading, "Thread") as thread,
        ):
            stats_emitter._refresh_latest_version()
            thread.return_value.start.assert_called_once()
            # run the thread body inline
            thread.call_args.kwargs["target"]()

        self.assertEqual(
            stats_emitter.stats_tracking["latest_frigate_version"], "0.19.0"
        )
        self.raise_notice.assert_called_once()

    def test_failed_refresh_keeps_the_last_known_version(self):
        stats_emitter = self._emitter("0.20.0")

        with (
            patch.object(emitter, "get_latest_version", return_value="unknown"),
            patch.object(emitter, "VERSION", "0.19.0-abcdef"),
            patch.object(emitter.threading, "Thread") as thread,
        ):
            stats_emitter._refresh_latest_version()
            thread.call_args.kwargs["target"]()

        self.assertEqual(
            stats_emitter.stats_tracking["latest_frigate_version"], "0.20.0"
        )
        self.raise_notice.assert_called_once_with(
            "update_available", scope="0.20.0", params={"version": "0.20.0"}
        )
        self.resolve_kind.assert_not_called()

    def test_disabled_version_check_still_clears_the_notice(self):
        stats_emitter = self._emitter("0.20.0")

        with (
            patch.object(emitter, "get_latest_version", return_value="disabled"),
            patch.object(emitter, "VERSION", "0.19.0-abcdef"),
            patch.object(emitter.threading, "Thread") as thread,
        ):
            stats_emitter._refresh_latest_version()
            thread.call_args.kwargs["target"]()

        self.assertEqual(
            stats_emitter.stats_tracking["latest_frigate_version"], "disabled"
        )
        self.resolve_kind.assert_called_once_with("update_available")


class TestForkUpdateNotice(unittest.TestCase):
    """Fork builds share one version number, so the fork checker decides."""

    LATEST = "0.18.0-20260924.48"

    def setUp(self):
        patches = [
            patch.object(emitter, "raise_notice"),
            patch.object(emitter, "resolve_kind"),
            patch.object(emitter, "get_checker"),
            patch.object(emitter, "VERSION", "0.18.0-abcdef1"),
        ]
        self.raise_notice, self.resolve_kind, self.get_checker, _ = (
            p.start() for p in patches
        )

        for p in patches:
            self.addCleanup(p.stop)

    def _check(self, status: str, latest: str = LATEST) -> None:
        self.get_checker.return_value.state.return_value = {"status": status}
        stats_emitter = emitter.StatsEmitter.__new__(emitter.StatsEmitter)
        stats_emitter.config = MagicMock()
        stats_emitter.stats_tracking = {"latest_frigate_version": latest}
        stats_emitter._check_update_notice()

    def test_a_newer_fork_build_raises(self):
        # the same 0.18.0 as the running build, which is_newer_version misses
        self._check("available")

        self.raise_notice.assert_called_once_with(
            "update_available", scope=self.LATEST, params={"version": self.LATEST}
        )
        self.resolve_kind.assert_not_called()

    def test_the_latest_or_a_local_build_resolves(self):
        for status in ("up-to-date", "development"):
            with self.subTest(status=status):
                self.resolve_kind.reset_mock()
                self._check(status)

                self.raise_notice.assert_not_called()
                self.resolve_kind.assert_called_once_with("update_available")

    def test_an_unreachable_checker_leaves_the_notice_alone(self):
        self._check("unknown")

        self.raise_notice.assert_not_called()
        self.resolve_kind.assert_not_called()

    def test_upstream_style_versions_skip_the_fork_checker(self):
        self._check("available", latest="0.19.0")

        self.get_checker.assert_not_called()
        self.raise_notice.assert_called_once_with(
            "update_available", scope="0.19.0", params={"version": "0.19.0"}
        )

    def test_run_checks_on_a_thread(self):
        stats_emitter = emitter.StatsEmitter.__new__(emitter.StatsEmitter)
        stats_emitter.stop_event = MagicMock()
        stats_emitter.stop_event.wait.return_value = True
        stats_emitter.config = MagicMock()
        stats_emitter.config.mqtt.stats_interval = 60
        stats_emitter.camera_history = MagicMock()
        stats_emitter.recording_health = MagicMock()
        stats_emitter.hardware_stats = MagicMock()
        stats_emitter.requestor = MagicMock()

        with (
            patch.object(emitter.time, "sleep"),
            patch.object(emitter, "flush_notices"),
            patch.object(emitter.threading, "Thread") as thread,
        ):
            stats_emitter.run()

        self.assertEqual(
            thread.call_args.kwargs["target"], stats_emitter._check_update_notice
        )
        thread.return_value.start.assert_called_once()
        stats_emitter.recording_health.start.assert_called_once()
        stats_emitter.recording_health.join.assert_called_once_with(timeout=5)
