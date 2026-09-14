"""Regression tests for generated admin credential handling."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from frigate.app import FrigateApp


class TestAdminPasswordLogging(unittest.TestCase):
    """Exercise setup and reset without exposing generated credentials."""

    def test_generated_password_is_never_logged(self):
        for user_count, reset in ((0, False), (1, True)):
            with self.subTest(user_count=user_count, reset=reset):
                app = MagicMock()
                app.config.auth.enabled = True
                app.config.auth.reset_admin_password = reset
                with (
                    tempfile.TemporaryDirectory() as directory,
                    patch("frigate.app.CONFIG_DIR", directory),
                    patch("frigate.app.User") as user,
                    patch("frigate.app.hash_password"),
                    patch(
                        "frigate.app.secrets.token_hex",
                        return_value="test-generated-credential",
                    ),
                    self.assertLogs("frigate.app", level="INFO") as logs,
                ):
                    user.select.return_value.count.return_value = user_count
                    FrigateApp.init_auth(app)
                    self.assertNotIn(
                        "test-generated-credential", "\n".join(logs.output)
                    )
                    credential = Path(directory) / "admin_password"
                    self.assertEqual(
                        credential.read_text(), "test-generated-credential\n"
                    )
                    self.assertEqual(credential.stat().st_mode & 0o777, 0o600)

    def test_file_failure_does_not_change_account(self):
        for user_count, reset in ((0, False), (1, True)):
            with self.subTest(user_count=user_count, reset=reset):
                app = MagicMock()
                app.config.auth.enabled = True
                app.config.auth.reset_admin_password = reset
                with (
                    patch("frigate.app.User") as user,
                    patch("frigate.app.hash_password"),
                    patch("frigate.app.save_admin_password", side_effect=OSError),
                ):
                    user.select.return_value.count.return_value = user_count
                    with self.assertRaises(OSError):
                        FrigateApp.init_auth(app)
                    user.insert.assert_not_called()
                    user.replace.assert_not_called()

    def test_existing_account_does_not_generate_password(self):
        app = MagicMock()
        app.config.auth.enabled = True
        app.config.auth.reset_admin_password = False
        with (
            patch("frigate.app.User") as user,
            patch("frigate.app.save_admin_password") as save,
        ):
            user.select.return_value.count.return_value = 1
            FrigateApp.init_auth(app)
            save.assert_not_called()


class TestPrivatePasswordFile(unittest.TestCase):
    """Check filesystem access and replacement behavior."""

    def test_replaces_symlink_without_modifying_target(self):
        from frigate.util.admin_password import save_admin_password

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "unrelated"
            target.write_text("unchanged")
            (root / "admin_password").symlink_to(target)
            save_admin_password("test-secret", root)
            result = root / "admin_password"
            self.assertFalse(result.is_symlink())
            self.assertEqual(target.read_text(), "unchanged")
            self.assertEqual(result.read_text(), "test-secret\n")
            self.assertEqual(result.stat().st_mode & 0o777, 0o600)

    def test_replaces_permissive_file_and_cleans_temporary_file(self):
        from frigate.util.admin_password import save_admin_password

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "admin_password"
            target.write_text("old")
            target.chmod(0o644)
            save_admin_password("new", root)
            self.assertEqual(target.read_text(), "new\n")
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(root.iterdir()), [target])

    def test_failed_replace_preserves_old_file_and_removes_temporary(self):
        from frigate.util.admin_password import save_admin_password

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "admin_password"
            target.write_text("old")
            with patch("frigate.util.atomic.os.replace", side_effect=OSError):
                with self.assertRaises(OSError):
                    save_admin_password("new", root)
            self.assertEqual(target.read_text(), "old")
            self.assertEqual(list(root.iterdir()), [target])


class TestRemoveAdminPassword(unittest.TestCase):
    """Credential cleanup must not turn a successful password change into failure."""

    def test_missing_file_is_already_clean(self):
        from frigate.util.admin_password import remove_admin_password

        with tempfile.TemporaryDirectory() as directory:
            remove_admin_password(Path(directory))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_unlink_failure_warns_without_exposing_password(self):
        from frigate.util.admin_password import remove_admin_password

        with tempfile.TemporaryDirectory() as directory:
            credential = Path(directory) / "admin_password"
            credential.write_text("synthetic-secret")
            with (
                patch(
                    "frigate.util.admin_password.Path.unlink",
                    side_effect=PermissionError,
                ),
                self.assertLogs("frigate.util.admin_password", level="WARNING") as logs,
            ):
                remove_admin_password(Path(directory))
            self.assertTrue(credential.exists())
            self.assertNotIn("synthetic-secret", "\n".join(logs.output))
            self.assertIn("manually", "\n".join(logs.output))
