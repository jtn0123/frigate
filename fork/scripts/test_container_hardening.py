"""Container hardening kept from upstream's phase 1 (E36, see fork/HARDENING.md)."""

import re
import shlex
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# The image-build scripts that download artifacts. Each download must be
# checked against a pinned sha256 digest before anything installs or runs it.
VERIFIED_SCRIPTS = (
    "docker/main/install_deps.sh",
    "docker/main/install_s6_overlay.sh",
    "docker/main/install_tempio.sh",
    "docker/main/install_hailort.sh",
    "docker/main/install_memryx.sh",
)
# Downloads deliberately left unpinned. The Intel apt signing key is a trust
# anchor that apt then uses to verify every package from that repository, and
# Intel rotates it in place at a fixed URL, so a digest pin would only turn a
# key rotation into a broken build (upstream leaves it unpinned too).
UNPINNED = {"https://repositories.intel.com/gpu/intel-graphics.key"}
DOCKERFILES = ("docker/main/Dockerfile", "docker/rocm/Dockerfile")
DIGEST = re.compile(r"[0-9a-f]{64}")
CHECK = re.compile(r'^echo "(?P<digest>\S+)  (?P<path>\S+)" \| sha256sum -c -$')
# a curl or wget invocation, as opposed to the package names in apt-get install
DOWNLOAD_COMMAND = re.compile(r"(?:^RUN|&&|;|\||\()\s*(?:curl|wget)\s")
LOOKUP = re.compile(r"^\$\{(?P<map>[a-z0-9_]+)\[\$\{(?P<key>[A-Za-z_]+)\}\]\}$")


def joined_lines(path: str) -> list[str]:
    """Read a script or Dockerfile with continuation lines joined and stripped."""
    text = (ROOT / path).read_text().replace("\\\n", " ")
    return [line.strip() for line in text.splitlines()]


def checksum_maps(text: str) -> dict[str, dict[str, str]]:
    """Parse every `declare -A <name>=( ["key"]="value" ... )` block."""
    maps: dict[str, dict[str, str]] = {}
    for match in re.finditer(
        r"declare -A (\w+)=\(\n(.*?)\n\s*\)", text, re.MULTILINE | re.DOTALL
    ):
        entries = re.findall(r'^\s*\["([^"]+)"\]="([^"]*)"$', match[2], re.MULTILINE)
        keys = [key for key, _ in entries]
        if len(keys) != len(set(keys)):
            raise AssertionError(f"duplicate key in {match[1]}")
        maps[match[1]] = dict(entries)
    return maps


def download_target(command: str) -> str | None:
    """Return the file a `download_https` call writes, or None for a variable URL."""
    tokens = shlex.split(command, posix=False)
    if "--output" in tokens:
        return tokens[tokens.index("--output") + 1].strip('"')
    url = next(token.strip('"') for token in tokens if "://" in token or "$" in token)
    return None if url.startswith("$") else url.rsplit("/", 1)[1]


class TestBuildDownloadsArePinned(unittest.TestCase):
    def test_every_download_is_followed_by_its_digest_check(self):
        unpinned: set[str] = set()
        for path in VERIFIED_SCRIPTS:
            text = (ROOT / path).read_text()
            maps = checksum_maps(text)
            lines = [line for line in joined_lines(path) if line]
            downloads = 0
            for index, line in enumerate(lines):
                if not line.startswith("download_https "):
                    continue
                downloads += 1
                if any(url in line.split() for url in UNPINNED):
                    unpinned.add(next(url for url in UNPINNED if url in line))
                    continue
                with self.subTest(path=path, download=line):
                    check = CHECK.match(lines[index + 1])
                    self.assertIsNotNone(check, "the next line must verify it")
                    digest = check["digest"]
                    lookup = LOOKUP.match(digest)
                    if lookup is None:
                        self.assertRegex(digest, f"^{DIGEST.pattern}$")
                    else:
                        self.assertIn(lookup["map"], maps)
                    target = download_target(line)
                    if target is not None:
                        self.assertEqual(check["path"], target)
            with self.subTest(path=path):
                self.assertGreater(downloads, 0, "no downloads found")
        # a stale exception must be removed, not left to excuse a new download
        self.assertEqual(unpinned, UNPINNED)

    def test_checksum_maps_hold_only_sha256_digests(self):
        for path in VERIFIED_SCRIPTS:
            for name, entries in checksum_maps((ROOT / path).read_text()).items():
                for key, value in entries.items():
                    with self.subTest(path=path, map=name, key=key):
                        self.assertRegex(value, f"^{DIGEST.pattern}$")

    def test_arch_keyed_digests_cover_both_architectures(self):
        expected = {
            "s6_checksums": {"noarch", "x86_64", "aarch64"},
            "tempio_checksums": {"amd64", "aarch64"},
            "hailort_checksums": {"amd64", "arm64", "x86_64", "aarch64"},
            "edgetpu_checksums": {"amd64", "arm64"},
            "yq_checksums": {"amd64", "arm64"},
        }
        found: dict[str, set[str]] = {}
        for path in VERIFIED_SCRIPTS:
            for name, entries in checksum_maps((ROOT / path).read_text()).items():
                found[name] = set(entries)
        for name, keys in expected.items():
            with self.subTest(map=name):
                self.assertEqual(found.get(name), keys)

    def test_every_intel_deb_has_exactly_one_digest(self):
        text = (ROOT / "docker/main/install_deps.sh").read_text()
        digests = checksum_maps(text)["intel_checksums"]
        fetched = re.findall(r"^\s*fetch_intel_deb (https://\S+)$", text, re.MULTILINE)
        names = [url.rsplit("/", 1)[1] for url in fetched]
        self.assertEqual(len(names), 13)
        self.assertEqual(sorted(names), sorted(digests))
        # the helper is the only remaining Intel download, and it verifies
        self.assertNotRegex(text, r"(?m)^\s*download_https --remote-name https://")

    def test_image_and_runtime_installers_pin_the_same_artifacts(self):
        # The image bakes HailoRT and MemryX in; the runtime installer can fetch
        # them again. A version bump in one place must not leave the other behind.
        pairs = (
            ("docker/main/install_hailort.sh", "frigate/detectors/plugins/hailo.py"),
            ("docker/main/install_memryx.sh", "frigate/detectors/plugins/memryx.py"),
        )
        for script, manifest in pairs:
            with self.subTest(script=script):
                image = set(DIGEST.findall((ROOT / script).read_text()))
                runtime = set(DIGEST.findall((ROOT / manifest).read_text()))
                self.assertTrue(image)
                self.assertEqual(image, runtime)


class TestDockerfileDownloadsArePinned(unittest.TestCase):
    def instructions(self, path: str) -> list[str]:
        """Return the Dockerfile's instructions, one joined line each."""
        return [
            line
            for line in joined_lines(path)
            if line and not line.startswith("#") and re.match(r"^[A-Z]+ ", line)
        ]

    def test_remote_add_sources_carry_a_checksum(self):
        for path in DOCKERFILES:
            for line in self.instructions(path):
                if line.startswith("ADD ") and "https://" in line:
                    with self.subTest(path=path, add=line):
                        self.assertRegex(line, rf"--checksum=sha256:{DIGEST.pattern}\s")

    def test_run_downloads_are_verified_in_the_same_step(self):
        for path in DOCKERFILES:
            for line in self.instructions(path):
                if line.startswith("RUN ") and DOWNLOAD_COMMAND.search(line):
                    with self.subTest(path=path, run=line):
                        self.assertIn("| sha256sum -c -", line)


class TestRuntimeHardening(unittest.TestCase):
    def test_nginx_does_not_disclose_its_version(self):
        conf = (ROOT / "docker/main/rootfs/usr/local/nginx/conf/nginx.conf").read_text()
        http = conf[conf.index("http {") :]
        self.assertIn("server_tokens off;", http[: http.index("server {")])

    def test_generated_tls_key_is_private(self):
        run = (ROOT / "docker/main/rootfs/etc/s6-overlay/s6-rc.d/nginx/run").read_text()
        branch = run[run.index("Generating a self signed certificate") :]
        branch = branch[: branch.index("\nfi\n")]
        generate = branch.index("openssl req ")
        key = branch.index('chmod 600 "$letsencrypt_path/privkey.pem"')
        cert = branch.index('chmod 644 "$letsencrypt_path/fullchain.pem"')
        self.assertLess(generate, key)
        self.assertLess(generate, cert)


if __name__ == "__main__":
    unittest.main()
