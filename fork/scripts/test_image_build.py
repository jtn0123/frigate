"""Check release target isolation and the local benchmark's cache semantics."""

import argparse
import importlib.util
import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "benchmark_image_build", Path(__file__).with_name("benchmark_image_build.py")
)
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


class TestImageBuild(unittest.TestCase):
    """Verify the resolved Bake graph, including inherited ROCm contexts."""

    def test_shared_graph_preserves_both_images_and_gpu_selection(self):
        env = os.environ | {
            "CACHE": "example.invalid/frigate:cache",
            "AMD64_TAGS": "example.invalid/frigate:sha-amd64,example.invalid/frigate:version",
            "ROCM_TAGS": "example.invalid/frigate:sha-rocm,example.invalid/frigate:version-rocm",
            "HSA_OVERRIDE": "0",
        }
        result = subprocess.run(
            [
                "docker",
                "buildx",
                "bake",
                "-f",
                "docker/rocm/rocm.hcl",
                "-f",
                "docker/fork.hcl",
                "--print",
                "fork",
            ],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=True,
        )
        graph = json.loads(result.stdout)
        self.assertEqual(graph["group"]["fork"]["targets"], ["amd64", "rocm"])
        targets = graph["target"]
        self.assertEqual(targets["amd64"]["target"], "frigate")
        self.assertEqual(targets["rocm"]["args"]["HSA_OVERRIDE"], "0")
        self.assertEqual(
            targets["rocm"]["contexts"],
            {
                "deps": "target:deps",
                "rootfs": "target:rootfs",
                "wget": "target:wget",
            },
        )
        for name in ("amd64", "rocm"):
            self.assertEqual(targets[name]["platforms"], ["linux/amd64"])
            self.assertEqual(len(targets[name]["tags"]), 2)
        self.assertNotEqual(targets["amd64"]["cache-to"], targets["rocm"]["cache-to"])

    def test_benchmark_does_not_import_release_caches_or_publish_release_tags(self):
        for case in ("baseline", "shared-gzip", "shared-zstd"):
            graph = benchmark.bake_override("localhost:5007", case, "cold", "gzip")
            for target in graph["target"].values():
                for ref in (
                    target.get("tags", [])
                    + target["cache-from"]
                    + target.get("cache-to", [])
                ):
                    self.assertIn(f"localhost:5007/{case}:", ref)
                    self.assertNotIn(":main", ref)
                    self.assertNotIn("ghcr.io", ref)

    def test_benchmark_resolved_graph_matches_release_without_external_caches(self):
        with tempfile.TemporaryDirectory() as directory:
            override = Path(directory) / "benchmark.json"
            override.write_text(
                json.dumps(
                    benchmark.bake_override(
                        "localhost:5007",
                        "shared-zstd",
                        "cold",
                        "zstd",
                    )
                )
            )
            env = os.environ | {
                "CACHE": "example.invalid/frigate:cache",
                "AMD64_TAGS": "example.invalid/frigate:amd64",
                "ROCM_TAGS": "example.invalid/frigate:rocm",
                "HSA_OVERRIDE": "0",
            }
            command = ["docker", "buildx", "bake", "-f", "docker/rocm/rocm.hcl", "-f"]

            def resolve(file, group):
                result = subprocess.run(
                    command + [str(file), "--print", group],
                    cwd=ROOT,
                    env=env,
                    capture_output=True,
                    text=True,
                    check=True,
                )
                return json.loads(result.stdout)["target"]

            release = resolve("docker/fork.hcl", "fork")
            trial = resolve(override, "benchmark")
            self.assertEqual(release.keys(), trial.keys())
            for name, target in trial.items():
                for cache in target["cache-from"]:
                    self.assertTrue(
                        cache["ref"].startswith("localhost:5007/shared-zstd:")
                    )
                for key in (
                    "context",
                    "dockerfile",
                    "target",
                    "contexts",
                    "args",
                    "platforms",
                ):
                    self.assertEqual(
                        target.get(key), release[name].get(key), (name, key)
                    )

    def test_cases_receive_the_same_immutable_seed_cache(self):
        seeds = ["ghcr.io/example/frigate@sha256:" + "a" * 64]
        for case in ("baseline", "shared-zstd"):
            graph = benchmark.bake_override(
                "localhost:5007", case, "cold", "gzip", seeds
            )
            for target in graph["target"].values():
                self.assertIn("type=registry,ref=" + seeds[0], target["cache-from"])
                for destination in target.get("cache-to", []):
                    self.assertNotIn("ghcr.io", destination)

    def test_app_change_reuses_its_own_cold_cache_with_distinct_image_tags(self):
        cold = benchmark.bake_override("localhost:5007", "baseline", "cold", "gzip")
        warm = benchmark.bake_override(
            "localhost:5007", "baseline", "app-change", "gzip"
        )
        for name in ("amd64", "rocm"):
            a, b = cold["target"][name], warm["target"][name]
            self.assertEqual(a["cache-from"], b["cache-from"])
            self.assertEqual(a["cache-to"], b["cache-to"])
            self.assertNotEqual(a["tags"], b["tags"])

    def test_log_summary_deduplicates_replayed_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "build.log"
            path.write_text(
                "#1 [rocm] exporting cache to registry\n#1 DONE 12.0s\n"
                "#2 [deps] RUN install\n#2 CACHED\n#2 CACHED\n"
                "#1 [rocm] exporting cache to registry\n#1 DONE 12.1s\n"
            )
            result = benchmark.summarize_log(path)
            self.assertEqual(result["cached_operations"], 1)
            self.assertEqual(len(result["operations"]), 1)
            self.assertEqual(result["operations"][0]["seconds"], 12.1)

    def test_failed_build_removes_builder_and_stops_the_phase(self):
        args = argparse.Namespace(
            context="colima-frigate-build-bench",
            case="baseline",
            source=Path("/source"),
            output=Path("/output"),
        )
        with (
            patch.object(benchmark.subprocess, "run") as run,
            patch.object(
                benchmark,
                "measure",
                side_effect=RuntimeError("build failed"),
            ) as measure,
        ):
            with self.assertRaisesRegex(RuntimeError, "build failed"):
                benchmark.build_targets(
                    args, Path("/config"), Path("/override"), "cold", ["amd64", "rocm"]
                )
            self.assertEqual(measure.call_count, 1)
            self.assertEqual(
                run.call_args.args[0][-3:], ["buildx", "rm", "frigate-bench-baseline"]
            )

    def test_application_copy_follows_rocm_dependencies_and_linker_cache(self):
        instructions = (ROOT / "docker/rocm/Dockerfile").read_text()
        application_copy = re.search(
            r"^COPY (?:--link )?--from=rootfs / /$", instructions, re.MULTILINE
        )
        self.assertIsNotNone(application_copy)
        application = application_copy.start()
        for dependency in (
            "pip3 install --only-binary",
            "COPY --from=rocm-dist",
            "RUN ldconfig",
        ):
            self.assertLess(instructions.index(dependency), application)


if __name__ == "__main__":
    unittest.main()
