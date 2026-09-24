"""Run the self-contained dependency image checks in the thin coverage image."""

import importlib.util
import unittest
from pathlib import Path


def load_tests(_loader: unittest.TestLoader, _tests: unittest.TestSuite, _pattern: str):
    """Reuse host tests that need no Docker CLI or release Dockerfiles."""
    path = Path(__file__).with_name("test_dependency_images.py")
    spec = importlib.util.spec_from_file_location("dependency_images_host_tests", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    names = (
        "test_frontend_only_change_does_not_rebuild_runtime_dependencies",
        "test_frontend_sources_invalidate_artifact_but_backend_and_output_do_not",
        "test_explicit_refresh_bypasses_cache_even_when_images_exist",
        "test_reused_images_skip_dependency_build_and_pin_runtime_inputs",
        "test_failed_dependency_build_never_starts_application_build",
        "test_registry_error_is_not_treated_as_missing_dependencies",
        "test_registry_digest_is_used_without_rehashing_formatted_output",
        "test_application_change_reuses_key_but_dependency_change_invalidates_it",
        "test_missing_input_fails_instead_of_reusing_incomplete_key",
        "test_runtime_references_require_exact_digest",
    )
    return unittest.TestSuite(module.TestDependencyImages(name) for name in names)


if __name__ == "__main__":
    unittest.main()
