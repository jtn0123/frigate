"""Run benchmark image isolation checks inside the thin coverage image."""

import importlib.util
import unittest
from pathlib import Path


def load_tests(_loader: unittest.TestLoader, _tests: unittest.TestSuite, _pattern: str):
    """Reuse host tests that mock Docker or inspect pure Bake overrides."""
    path = Path(__file__).with_name("test_image_build.py")
    spec = importlib.util.spec_from_file_location("image_build_host_tests", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    names = (
        "test_benchmark_does_not_import_release_caches_or_publish_release_tags",
        "test_cases_receive_the_same_immutable_seed_cache",
        "test_app_change_reuses_its_own_cold_cache_with_distinct_image_tags",
        "test_log_summary_deduplicates_replayed_progress",
        "test_failed_build_removes_builder_and_stops_the_phase",
        "test_dependency_benchmark_keeps_limits_and_private_destinations",
    )
    return unittest.TestSuite(module.TestImageBuild(name) for name in names)


if __name__ == "__main__":
    unittest.main()
