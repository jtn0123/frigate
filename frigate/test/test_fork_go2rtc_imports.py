"""B42 (upstream #24648): go2rtc's config script stays off the config package.

`create_config.py` runs before go2rtc starts. Importing `frigate.config` runs
its package init, which loads every detector plugin and onnxruntime, and that
can take long enough for the cameras to start before the restream is up.
"""

import ast
import subprocess
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
# the source tree has the script under the image rootfs; the image installs it
CREATE_CONFIG = next(
    path
    for path in (
        REPO_ROOT / "docker/main/rootfs/usr/local/go2rtc/create_config.py",
        Path("/usr/local/go2rtc/create_config.py"),
    )
    if path.exists()
)


def frigate_imports(path: Path) -> list[str]:
    """Return the frigate modules a script imports at module level."""
    tree = ast.parse(path.read_text())
    modules = []

    for node in tree.body:
        if isinstance(node, ast.ImportFrom) and node.module:
            if node.module.split(".")[0] == "frigate":
                modules.append(node.module)
        elif isinstance(node, ast.Import):
            modules.extend(
                alias.name
                for alias in node.names
                if alias.name.split(".")[0] == "frigate"
            )

    return modules


class TestGo2rtcConfigImports(unittest.TestCase):
    def test_script_imports_env_helpers_from_util(self):
        modules = frigate_imports(CREATE_CONFIG)

        self.assertIn("frigate.util.env", modules)
        self.assertFalse(
            [
                m
                for m in modules
                if m == "frigate.config" or m.startswith("frigate.config.")
            ]
        )

    def test_script_imports_do_not_load_the_config_package(self):
        modules = frigate_imports(CREATE_CONFIG)
        code = "\n".join(
            [
                "import importlib, sys",
                *(f"importlib.import_module({m!r})" for m in modules),
                "print(','.join(m for m in ('frigate.config', 'onnxruntime')"
                " if m in sys.modules))",
            ]
        )

        result = subprocess.run(
            [sys.executable, "-c", code],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=120,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main()
