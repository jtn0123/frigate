"""Coverage tests for the config migration and helper utilities."""

import logging
import os
import stat
import tempfile
import unittest
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
from ruamel.yaml import YAML

from frigate.config import FrigateConfig
from frigate.const import REDACTED_CREDENTIAL_SENTINEL
from frigate.util import config as config_util
from frigate.util.config import (
    CURRENT_CONFIG_VERSION,
    StreamInfoRetriever,
    _convert_legacy_mask_to_dict,
    _log_dropped_detector_options,
    _merge_detector_model_path,
    _migrate_birdseye_mode,
    _migrated_device,
    apply_section_update,
    convert_area_to_pixels,
    find_config_file,
    frigate_service_is_granular_root,
    get_relative_coordinates,
    is_runtime_user_writable,
    migrate_014,
    migrate_015_0,
    migrate_015_1,
    migrate_016_0,
    migrate_017_0,
    migrate_018_0,
    migrate_019_0,
    migrate_frigate_config,
    migrate_models,
    redact_credential,
    rename_hailo_detector,
    resolve_ffmpeg_path,
)

LOGGER_NAME = "frigate.util.config"


class TestFrigateServiceIsGranularRoot(unittest.TestCase):
    """The granular root check depends on euid and two env variables."""

    def _check(self, euid: int, env: dict[str, str]) -> bool:
        with (
            patch("frigate.util.config.os.geteuid", return_value=euid),
            patch.dict(os.environ, env, clear=False),
        ):
            for key in ("FRIGATE_RUN_AS_ROOT", "FRIGATE_ROOT_SERVICES"):
                if key not in env:
                    os.environ.pop(key, None)
            return frigate_service_is_granular_root()

    def test_non_root_is_never_granular_root(self) -> None:
        self.assertFalse(self._check(1000, {"FRIGATE_ROOT_SERVICES": "frigate"}))

    def test_run_as_root_escape_hatch_is_excluded(self) -> None:
        self.assertFalse(
            self._check(
                0,
                {"FRIGATE_RUN_AS_ROOT": "true", "FRIGATE_ROOT_SERVICES": "frigate"},
            )
        )

    def test_frigate_listed_among_root_services(self) -> None:
        self.assertTrue(
            self._check(0, {"FRIGATE_ROOT_SERVICES": "nginx, frig ate ,go2rtc"})
        )

    def test_frigate_not_listed(self) -> None:
        self.assertFalse(self._check(0, {"FRIGATE_ROOT_SERVICES": "nginx,go2rtc"}))

    def test_no_root_services_set(self) -> None:
        self.assertFalse(self._check(0, {}))


class TestIsRuntimeUserWritable(unittest.TestCase):
    """Paths inside writable roots or below world-writable dirs are unsafe."""

    @staticmethod
    def _fake_stat(modes: dict[str, Any]):
        """Build a Path.stat replacement driven by a path to mode/exception map."""

        def fake_stat(self, *args, **kwargs):
            value = modes.get(str(self), 0o755)
            if isinstance(value, BaseException):
                raise value
            result = MagicMock()
            result.st_mode = stat.S_IFDIR | value
            return result

        return fake_stat

    def test_path_inside_a_writable_root(self) -> None:
        with patch.object(config_util, "RUNTIME_USER_WRITABLE_DIRS", ("/wroot",)):
            self.assertTrue(is_runtime_user_writable("/wroot/bin/ffmpeg"))
            self.assertTrue(is_runtime_user_writable("/wroot"))

    def test_sibling_with_shared_prefix_is_not_inside_root(self) -> None:
        with (
            patch.object(config_util, "RUNTIME_USER_WRITABLE_DIRS", ("/wroot",)),
            patch("pathlib.Path.stat", self._fake_stat({})),
        ):
            self.assertFalse(is_runtime_user_writable("/wroot2/bin/ffmpeg"))

    def test_world_writable_ancestor(self) -> None:
        with (
            patch.object(config_util, "RUNTIME_USER_WRITABLE_DIRS", ("/wroot",)),
            patch("pathlib.Path.stat", self._fake_stat({"/opt/shared": 0o777})),
        ):
            self.assertTrue(is_runtime_user_writable("/opt/shared/ffmpeg/bin"))

    def test_missing_components_are_skipped(self) -> None:
        modes = {
            "/opt/custom/bin": FileNotFoundError(),
            "/opt/custom": FileNotFoundError(),
        }
        with (
            patch.object(config_util, "RUNTIME_USER_WRITABLE_DIRS", ("/wroot",)),
            patch("pathlib.Path.stat", self._fake_stat(modes)),
        ):
            self.assertFalse(is_runtime_user_writable("/opt/custom/bin"))

    def test_unreadable_ancestor_is_treated_as_writable(self) -> None:
        with (
            patch.object(config_util, "RUNTIME_USER_WRITABLE_DIRS", ("/wroot",)),
            patch(
                "pathlib.Path.stat",
                self._fake_stat({"/opt/locked": PermissionError()}),
            ),
        ):
            self.assertTrue(is_runtime_user_writable("/opt/locked/bin"))

    def test_real_world_writable_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = os.path.join(temp_dir, "open")
            os.mkdir(target)
            # world writable on purpose, it is the case under test
            os.chmod(target, 0o777)  # noqa: S103
            with patch.object(
                config_util, "RUNTIME_USER_WRITABLE_DIRS", ("/nonexistent-root",)
            ):
                self.assertTrue(is_runtime_user_writable(target))


class TestResolveFfmpegPath(unittest.TestCase):
    """Version aliases map to bundled builds, absolute paths are kept."""

    def setUp(self) -> None:
        for name, value in (
            ("DEFAULT_FFMPEG_VERSION", "7.0"),
            ("INCLUDED_FFMPEG_VERSIONS", ["7.0", "5.0"]),
        ):
            patcher = patch.object(config_util, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_default_alias(self) -> None:
        self.assertEqual(
            resolve_ffmpeg_path("default"), "/usr/lib/ffmpeg/7.0/bin/ffmpeg"
        )

    def test_bundled_version(self) -> None:
        self.assertEqual(
            resolve_ffmpeg_path("5.0", "ffprobe"), "/usr/lib/ffmpeg/5.0/bin/ffprobe"
        )

    def test_dropped_version_falls_back_to_default(self) -> None:
        self.assertEqual(resolve_ffmpeg_path("4.0"), "/usr/lib/ffmpeg/7.0/bin/ffmpeg")

    def test_custom_absolute_path(self) -> None:
        self.assertEqual(
            resolve_ffmpeg_path("/opt/ffmpeg", "ffprobe"), "/opt/ffmpeg/bin/ffprobe"
        )


class TestRedactCredential(unittest.TestCase):
    """Saved credentials become the sentinel, empty ones are dropped."""

    def test_saved_value_is_replaced(self) -> None:
        obj = {"password": "hunter2"}
        redact_credential(obj, "password")
        self.assertEqual(obj, {"password": REDACTED_CREDENTIAL_SENTINEL})

    def test_empty_value_is_dropped(self) -> None:
        obj: dict[str, Any] = {"password": "", "user": "a"}
        redact_credential(obj, "password")
        self.assertEqual(obj, {"user": "a"})

    def test_missing_value_is_a_no_op(self) -> None:
        obj = {"user": "a"}
        redact_credential(obj, "password")
        self.assertEqual(obj, {"user": "a"})


class TestFindConfigFile(unittest.TestCase):
    """The config file path honors CONFIG_FILE and falls back to .yaml."""

    def test_existing_file_is_returned(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = os.path.join(temp_dir, "config.yml")
            open(path, "w").close()
            with patch.dict(os.environ, {"CONFIG_FILE": path}):
                self.assertEqual(find_config_file(), path)

    def test_missing_yml_falls_back_to_yaml(self) -> None:
        with patch.dict(os.environ, {"CONFIG_FILE": "/nowhere/frigate.yml"}):
            self.assertEqual(find_config_file(), "/nowhere/frigate.yaml")

    def test_default_path_is_used_without_env(self) -> None:
        with (
            patch.dict(os.environ, {}, clear=False),
            patch.object(config_util, "DEFAULT_CONFIG_FILE", "/nowhere/config.yml"),
        ):
            os.environ.pop("CONFIG_FILE", None)
            self.assertEqual(find_config_file(), "/nowhere/config.yaml")


class TestMigrate014(unittest.TestCase):
    """Required zones move to review and rtmp and old ui keys are removed."""

    def test_global_and_camera_migration(self) -> None:
        config: dict[str, Any] = {
            "record": {"events": {"required_zones": ["yard"]}},
            "ui": {"use_experimental": True, "live_mode": "mse"},
            "ffmpeg": {"output_args": {"rtmp": "-c copy", "record": "x"}},
            "rtmp": {"enabled": True},
            "cameras": {
                "front": {
                    "record": {
                        "enabled": True,
                        "events": {"required_zones": ["porch"], "pre_capture": 5},
                    },
                    "ffmpeg": {"output_args": {"rtmp": "-c copy"}},
                    "rtmp": {"enabled": False, "other": 1},
                },
                "back": {
                    "record": {"events": {"required_zones": ["deck"]}},
                    "review": {"alerts": {"required_zones": ["kept"]}},
                },
            },
        }

        migrated = migrate_014(config)

        self.assertEqual(migrated["version"], "0.14")
        self.assertEqual(migrated["review"], {"alerts": {"required_zones": ["yard"]}})
        self.assertNotIn("record", migrated)
        self.assertNotIn("ui", migrated)
        self.assertNotIn("rtmp", migrated)
        self.assertEqual(migrated["ffmpeg"]["output_args"], {"record": "x"})

        front = migrated["cameras"]["front"]
        self.assertEqual(front["review"]["alerts"]["required_zones"], ["porch"])
        self.assertEqual(
            front["record"], {"enabled": True, "events": {"pre_capture": 5}}
        )
        self.assertEqual(front["ffmpeg"]["output_args"], {})
        self.assertNotIn("rtmp", front)

        back = migrated["cameras"]["back"]
        # an existing review required_zones wins over the record one
        self.assertEqual(back["review"]["alerts"]["required_zones"], ["kept"])
        self.assertNotIn("record", back)

    def test_partial_ui_and_existing_review(self) -> None:
        config: dict[str, Any] = {
            "record": {"events": {"required_zones": ["yard"], "post_capture": 3}},
            "review": {"alerts": {"required_zones": ["existing"]}},
            "ui": {"use_experimental": True, "timezone": "UTC"},
            "cameras": {},
        }

        migrated = migrate_014(config)

        self.assertEqual(migrated["review"]["alerts"]["required_zones"], ["existing"])
        self.assertEqual(migrated["record"], {"events": {"post_capture": 3}})
        self.assertEqual(migrated["ui"], {"timezone": "UTC"})

    def test_review_without_alerts_gets_alerts(self) -> None:
        config: dict[str, Any] = {
            "record": {"enabled": True, "events": {"required_zones": ["yard"]}},
            "review": {"detections": {}},
            "cameras": {
                "cam": {
                    "record": {"events": {"required_zones": ["z"]}},
                    "review": {"detections": {}},
                }
            },
        }

        migrated = migrate_014(config)

        self.assertEqual(migrated["review"]["alerts"], {"required_zones": ["yard"]})
        self.assertEqual(migrated["record"], {"enabled": True})
        self.assertEqual(
            migrated["cameras"]["cam"]["review"]["alerts"], {"required_zones": ["z"]}
        )

    def test_config_without_legacy_keys(self) -> None:
        migrated = migrate_014({"mqtt": {"host": "m"}})
        self.assertEqual(migrated, {"mqtt": {"host": "m"}, "version": "0.14"})


class TestMigrate0150(unittest.TestCase):
    """record.events splits into record.alerts and record.detections."""

    def test_global_events_without_required_zones(self) -> None:
        config: dict[str, Any] = {
            "record": {
                "events": {
                    "pre_capture": 5,
                    "post_capture": 10,
                    "retain": {"default": 14},
                }
            },
        }

        migrated = migrate_015_0(config)

        expected = {"pre_capture": 5, "post_capture": 10, "retain": {"days": 14}}
        self.assertEqual(migrated["record"]["alerts"], expected)
        self.assertEqual(migrated["record"]["detections"], expected)
        self.assertNotIn("events", migrated["record"])
        self.assertEqual(migrated["version"], "0.15-0")

    def test_global_events_with_required_zones_use_continuous_days(self) -> None:
        config: dict[str, Any] = {
            "record": {"retain": {"days": 3}, "events": {"pre_capture": 2}},
            "review": {"alerts": {"required_zones": ["yard"]}},
        }

        migrated = migrate_015_0(config)

        self.assertEqual(migrated["record"]["alerts"], {"pre_capture": 2, "retain": {}})
        self.assertEqual(migrated["record"]["detections"], {"retain": {"days": 3}})

    def test_global_events_with_required_zones_default_to_one_day(self) -> None:
        config: dict[str, Any] = {
            "record": {"events": {"post_capture": 2}},
            "review": {"alerts": {"required_zones": ["yard"]}},
        }

        migrated = migrate_015_0(config)

        self.assertEqual(migrated["record"]["detections"], {"retain": {"days": 1}})

    def test_camera_events(self) -> None:
        config: dict[str, Any] = {
            "cameras": {
                "a": {
                    "record": {
                        "events": {
                            "pre_capture": 1,
                            "post_capture": 2,
                            "retain": {"default": 7},
                        }
                    }
                },
                "b": {
                    "record": {"retain": {"days": 4}, "events": {"pre_capture": 3}},
                    "review": {"alerts": {"required_zones": ["z"]}},
                },
                "c": {
                    "record": {"events": {"post_capture": 3}},
                    "review": {"alerts": {"required_zones": ["z"]}},
                },
                "d": {"detect": {"enabled": True}},
            }
        }

        migrated = migrate_015_0(config)
        cameras = migrated["cameras"]

        full = {"pre_capture": 1, "post_capture": 2, "retain": {"days": 7}}
        self.assertEqual(cameras["a"]["record"]["alerts"], full)
        self.assertEqual(cameras["a"]["record"]["detections"], full)
        self.assertNotIn("events", cameras["a"]["record"])
        self.assertEqual(cameras["b"]["record"]["detections"], {"retain": {"days": 4}})
        self.assertEqual(cameras["c"]["record"]["detections"], {"retain": {"days": 1}})
        self.assertEqual(cameras["d"], {"detect": {"enabled": True}})


class TestMigrate0151(unittest.TestCase):
    """A detector model.path moves to model_path."""

    def test_model_path_is_moved(self) -> None:
        config: dict[str, Any] = {
            "detectors": {
                "coral": {"type": "edgetpu", "model": {"path": "/m.tflite"}},
                "cpu": {"type": "cpu"},
            }
        }

        migrated = migrate_015_1(config)

        self.assertEqual(
            migrated["detectors"]["coral"],
            {"type": "edgetpu", "model_path": "/m.tflite"},
        )
        self.assertEqual(migrated["detectors"]["cpu"], {"type": "cpu"})
        self.assertEqual(migrated["version"], "0.15-1")


class TestMigrate0160(unittest.TestCase):
    """detect.enabled defaults on, live stream_name and weights are migrated."""

    def test_detect_enabled_is_set_when_missing(self) -> None:
        migrated = migrate_016_0({"detect": {"fps": 5}})
        self.assertEqual(migrated["detect"], {"fps": 5, "enabled": True})
        self.assertEqual(migrated["version"], "0.16-0")

        self.assertEqual(migrate_016_0({})["detect"], {"enabled": True})

    def test_explicit_detect_enabled_is_kept(self) -> None:
        migrated = migrate_016_0({"detect": {"enabled": False}})
        self.assertEqual(migrated["detect"], {"enabled": False})

    def test_camera_live_and_autotracking(self) -> None:
        config: dict[str, Any] = {
            "detect": {"enabled": True},
            "cameras": {
                "a": {
                    "live": {"stream_name": "main", "height": 720},
                    "onvif": {
                        "autotracking": {"movement_weights": "1, 2, 3, 4, 5"},
                    },
                },
                "b": {
                    "onvif": {
                        "autotracking": {"movement_weights": "1, 2, 3, 4, 5, 6"},
                    },
                },
                "c": {"onvif": {"autotracking": {"enabled": True}}},
            },
        }

        migrated = migrate_016_0(config)
        cameras = migrated["cameras"]

        self.assertEqual(
            cameras["a"]["live"], {"height": 720, "streams": {"main": "main"}}
        )
        self.assertEqual(
            cameras["a"]["onvif"]["autotracking"]["movement_weights"],
            "1, 2, 3, 4, 5, 0",
        )
        self.assertEqual(
            cameras["b"]["onvif"]["autotracking"]["movement_weights"],
            "1, 2, 3, 4, 5, 6",
        )
        self.assertEqual(cameras["c"]["onvif"], {"autotracking": {"enabled": True}})


class TestMigrate0170(unittest.TestCase):
    """record.retain becomes continuous/motion and genai settings split."""

    def test_global_retain_mode_all(self) -> None:
        migrated = migrate_017_0({"record": {"retain": {"days": 5, "mode": "all"}}})

        self.assertEqual(migrated["record"]["continuous"], {"days": 5})
        self.assertEqual(migrated["record"]["motion"], {"days": 5})
        self.assertNotIn("retain", migrated["record"])
        self.assertEqual(migrated["version"], "0.17-0")

    def test_global_retain_mode_motion(self) -> None:
        migrated = migrate_017_0({"record": {"retain": {"days": 2, "mode": "motion"}}})

        self.assertEqual(migrated["record"]["continuous"], {"days": 0})
        self.assertEqual(migrated["record"]["motion"], {"days": 2})

    def test_global_retain_without_days(self) -> None:
        migrated = migrate_017_0({"record": {"retain": {"mode": "all"}}})

        self.assertEqual(migrated["record"], {})

    def test_global_genai_is_split(self) -> None:
        migrated = migrate_017_0(
            {
                "genai": {
                    "provider": "ollama",
                    "model": "llava",
                    "base_url": "http://ollama",
                    "enabled": True,
                    "prompt": "describe",
                },
                "objects": {"track": ["person"]},
            }
        )

        self.assertEqual(
            migrated["genai"],
            {"provider": "ollama", "model": "llava", "base_url": "http://ollama"},
        )
        self.assertEqual(
            migrated["objects"],
            {"track": ["person"], "genai": {"enabled": True, "prompt": "describe"}},
        )

    def test_camera_retain_and_genai(self) -> None:
        config: dict[str, Any] = {
            "cameras": {
                "a": {"record": {"retain": {"days": 4}}},
                "b": {"record": {"retain": {"days": 6, "mode": "active_objects"}}},
                "c": {"record": {"retain": {"mode": "all"}, "enabled": True}},
                "d": {
                    "genai": {"enabled": True},
                    "objects": {"track": ["car"]},
                },
                "e": {"genai": {"enabled": False, "prompt": "x"}},
            }
        }

        migrated = migrate_017_0(config)
        cameras = migrated["cameras"]

        self.assertEqual(cameras["a"]["record"]["continuous"], {"days": 4})
        self.assertNotIn("retain", cameras["a"]["record"])
        self.assertEqual(cameras["b"]["record"]["continuous"], {"days": 0})
        self.assertEqual(cameras["b"]["record"]["motion"], {"days": 6})
        self.assertEqual(cameras["c"]["record"], {"enabled": True})
        self.assertEqual(
            cameras["d"],
            {"objects": {"track": ["car"], "genai": {"enabled": True}}},
        )
        self.assertEqual(
            cameras["e"], {"objects": {"genai": {"enabled": False, "prompt": "x"}}}
        )


class TestConvertLegacyMask(unittest.TestCase):
    """Legacy string and list masks become named mask dicts."""

    def test_empty_masks(self) -> None:
        self.assertEqual(_convert_legacy_mask_to_dict(None), {})
        self.assertEqual(_convert_legacy_mask_to_dict(""), {})
        self.assertEqual(_convert_legacy_mask_to_dict([]), {})

    def test_string_motion_mask(self) -> None:
        self.assertEqual(
            _convert_legacy_mask_to_dict("0,0,1,1"),
            {
                "motion_mask_1": {
                    "friendly_name": "Motion Mask 1",
                    "enabled": True,
                    "coordinates": "0,0,1,1",
                }
            },
        )

    def test_string_object_mask_with_label(self) -> None:
        result = _convert_legacy_mask_to_dict("0,0,1,1", "object_mask", "person")
        self.assertEqual(
            result["object_mask_1"]["friendly_name"], "Object Mask 1 (person)"
        )

    def test_list_keeps_original_numbering_and_skips_empty(self) -> None:
        result = _convert_legacy_mask_to_dict(["a", "", "b"], "object_mask")
        self.assertEqual(list(result), ["object_mask_1", "object_mask_3"])
        self.assertEqual(result["object_mask_3"]["friendly_name"], "Object Mask 3")
        self.assertEqual(result["object_mask_3"]["coordinates"], "b")

    def test_list_with_label(self) -> None:
        result = _convert_legacy_mask_to_dict(["a", "b"], "object_mask", "car")
        self.assertEqual(
            result["object_mask_2"]["friendly_name"], "Object Mask 2 (car)"
        )

    def test_unsupported_type_returns_empty(self) -> None:
        self.assertEqual(_convert_legacy_mask_to_dict(5), {})  # type: ignore[arg-type]


class TestMigrateBirdseyeMode(unittest.TestCase):
    """Scalar Birdseye modes become a modes list."""

    def test_known_modes_are_converted(self) -> None:
        for legacy, new in (
            ("continuous", "continuous"),
            ("motion", "motion"),
            ("objects", "all_objects"),
        ):
            birdseye: dict[str, Any] = {"mode": legacy, "enabled": True}
            _migrate_birdseye_mode(birdseye)
            self.assertEqual(birdseye, {"enabled": True, "modes": [new]})

    def test_untouched_inputs(self) -> None:
        _migrate_birdseye_mode(None)
        _migrate_birdseye_mode({})

        non_string: dict[str, Any] = {"mode": ["motion"]}
        _migrate_birdseye_mode(non_string)
        self.assertEqual(non_string, {"mode": ["motion"]})

        unknown: dict[str, Any] = {"mode": "sometimes"}
        _migrate_birdseye_mode(unknown)
        self.assertEqual(unknown, {"mode": "sometimes"})


class TestMigrate0180(unittest.TestCase):
    """GenAI, deprecated keys and legacy masks are migrated for 0.18."""

    def test_global_migration(self) -> None:
        config: dict[str, Any] = {
            "genai": {"provider": "openai", "model": "gpt"},
            "record": {"sync_recordings": True, "export": {"timelapse_args": "-x"}},
            "motion": {"mask": "0,0,1,1"},
            "objects": {
                "mask": ["0,0,1,1"],
                "filters": {
                    "person": {"mask": "0,0,2,2"},
                    "car": {"mask": {"already": {"coordinates": "1"}}},
                    "dog": {"min_area": 10},
                    "cat": "ignored",
                },
            },
            "snapshots": {"clean_copy": True},
            "ui": {"date_style": "short", "time_style": "short"},
        }

        migrated = migrate_018_0(config)

        self.assertEqual(migrated["version"], "0.18-0")
        self.assertEqual(
            migrated["genai"],
            {
                "default": {
                    "provider": "openai",
                    "model": "gpt",
                    "roles": ["descriptions", "chat"],
                }
            },
        )
        self.assertNotIn("record", migrated)
        self.assertNotIn("snapshots", migrated)
        self.assertNotIn("ui", migrated)
        self.assertEqual(
            migrated["motion"]["mask"]["motion_mask_1"]["coordinates"], "0,0,1,1"
        )
        self.assertEqual(list(migrated["objects"]["mask"]), ["object_mask_1"])
        filters = migrated["objects"]["filters"]
        self.assertEqual(
            filters["person"]["mask"]["object_mask_1"]["friendly_name"],
            "Object Mask 1 (person)",
        )
        self.assertEqual(filters["car"]["mask"], {"already": {"coordinates": "1"}})
        self.assertEqual(filters["dog"], {"min_area": 10})

    def test_non_empty_sections_are_kept(self) -> None:
        config: dict[str, Any] = {
            "genai": {"enabled": True},
            "record": {
                "enabled": True,
                "export": {"timelapse_args": "-x", "hwaccel_args": "auto"},
            },
            "motion": {"mask": None, "threshold": 30},
            "objects": {"mask": {"m": {"coordinates": "1"}}},
            "snapshots": {"clean_copy": False, "enabled": True},
            "ui": {"date_style": "short", "timezone": "UTC"},
        }

        migrated = migrate_018_0(config)

        self.assertEqual(migrated["genai"], {"enabled": True})
        self.assertEqual(
            migrated["record"], {"enabled": True, "export": {"hwaccel_args": "auto"}}
        )
        self.assertEqual(migrated["motion"], {"mask": None, "threshold": 30})
        self.assertEqual(migrated["objects"], {"mask": {"m": {"coordinates": "1"}}})
        self.assertEqual(migrated["snapshots"], {"enabled": True})
        self.assertEqual(migrated["ui"], {"timezone": "UTC"})

    def test_record_with_only_export_is_removed(self) -> None:
        migrated = migrate_018_0({"record": {"export": {"timelapse_args": "-x"}}})
        self.assertNotIn("record", migrated)

    def test_camera_migration(self) -> None:
        config: dict[str, Any] = {
            "cameras": {
                "a": {
                    "record": {
                        "sync_recordings": False,
                        "export": {"timelapse_args": "-y"},
                    },
                    "motion": {"mask": ["0,0,1,1", "1,1,2,2"]},
                    "objects": {
                        "mask": "0,0,3,3",
                        "filters": {
                            "person": {"mask": ["0,0,4,4"]},
                            "car": {"mask": {"keep": {}}},
                        },
                    },
                    "snapshots": {"clean_copy": True},
                },
                "b": {
                    "record": {
                        "enabled": True,
                        "export": {"timelapse_args": "-y", "other": 1},
                    },
                    "snapshots": {"clean_copy": True, "enabled": True},
                    "motion": {"mask": {"keep": {}}},
                },
                "c": {"record": {"export": {"timelapse_args": "-y"}, "enabled": True}},
            }
        }

        migrated = migrate_018_0(config)
        a = migrated["cameras"]["a"]
        b = migrated["cameras"]["b"]
        c = migrated["cameras"]["c"]

        self.assertNotIn("record", a)
        self.assertNotIn("snapshots", a)
        self.assertEqual(list(a["motion"]["mask"]), ["motion_mask_1", "motion_mask_2"])
        self.assertEqual(
            a["objects"]["mask"]["object_mask_1"]["friendly_name"], "Object Mask 1"
        )
        self.assertEqual(
            a["objects"]["filters"]["person"]["mask"]["object_mask_1"]["friendly_name"],
            "Object Mask 1 (person)",
        )
        self.assertEqual(a["objects"]["filters"]["car"]["mask"], {"keep": {}})

        self.assertEqual(b["record"], {"enabled": True, "export": {"other": 1}})
        self.assertEqual(b["snapshots"], {"enabled": True})
        self.assertEqual(b["motion"], {"mask": {"keep": {}}})

        self.assertEqual(c["record"], {"enabled": True})


class TestRenameHailoDetectorEdges(unittest.TestCase):
    """Entries that are not shaped like a models list are skipped."""

    def test_malformed_entries_are_skipped(self) -> None:
        migrated = rename_hailo_detector(
            {
                "models": [
                    "not-a-dict",
                    {"devices": "hailo8l"},
                    {"devices": [5, "hailo8l:0", None]},
                ]
            }
        )

        self.assertEqual(migrated["models"][0], "not-a-dict")
        self.assertEqual(migrated["models"][1], {"devices": "hailo8l"})
        self.assertEqual(migrated["models"][2]["devices"], [5, "hailo:0", None])


class TestMigrate0190(unittest.TestCase):
    """Birdseye modes and the hailo detector are migrated for 0.19."""

    def test_migration(self) -> None:
        config: dict[str, Any] = {
            "models": [{"devices": ["hailo8l:PCIe"]}],
            "birdseye": {"mode": "objects"},
            "cameras": {
                "a": {
                    "birdseye": {"mode": "motion"},
                    "profiles": {
                        "night": {"birdseye": {"mode": "continuous"}},
                        "broken": None,
                    },
                },
                "b": {},
            },
        }

        migrated = migrate_019_0(config)

        self.assertEqual(migrated["version"], "0.19-0")
        self.assertEqual(migrated["models"][0]["devices"], ["hailo:PCIe"])
        self.assertEqual(migrated["birdseye"], {"modes": ["all_objects"]})
        a = migrated["cameras"]["a"]
        self.assertEqual(a["birdseye"], {"modes": ["motion"]})
        self.assertEqual(a["profiles"]["night"]["birdseye"], {"modes": ["continuous"]})
        self.assertIsNone(a["profiles"]["broken"])
        self.assertEqual(migrated["cameras"]["b"], {})


class TestDetectorMigrationHelpers(unittest.TestCase):
    """Device strings, dropped options and model_path merging."""

    def test_migrated_device(self) -> None:
        self.assertEqual(_migrated_device({}), ("cpu", "cpu"))
        self.assertEqual(
            _migrated_device({"type": "cpu", "num_threads": 3}), ("cpu", "cpu:3")
        )
        self.assertEqual(
            _migrated_device({"type": "zmq", "endpoint": "ipc:///tmp/z"}),
            ("zmq", "zmq:ipc:///tmp/z"),
        )
        self.assertEqual(
            _migrated_device({"type": "degirum", "location": "@cloud"}),
            ("degirum", "degirum:@cloud"),
        )
        self.assertEqual(_migrated_device({"type": "hailo8l"}), ("hailo", "hailo"))
        self.assertEqual(
            _migrated_device({"type": "onnx", "device": "AUTO"}), ("onnx", "onnx:AUTO")
        )

    def test_dropped_options_are_logged(self) -> None:
        with self.assertLogs(LOGGER_NAME, level=logging.ERROR) as logs:
            _log_dropped_detector_options(
                "z",
                "zmq",
                {"request_timeout_ms": 10, "linger_ms": 5, "endpoint": "x"},
            )

        self.assertEqual(len(logs.output), 1)
        self.assertIn("'z'", logs.output[0])
        self.assertIn("request_timeout_ms, linger_ms", logs.output[0])

    def test_nothing_dropped_logs_nothing(self) -> None:
        with self.assertNoLogs(LOGGER_NAME, level=logging.ERROR):
            _log_dropped_detector_options("c", "cpu", {"num_threads": 3})
            _log_dropped_detector_options("d", "degirum", {"location": "x"})

    def test_merge_model_path(self) -> None:
        self.assertIsNone(_merge_detector_model_path("a", {}, None))
        self.assertEqual(_merge_detector_model_path("a", {}, "/first"), "/first")
        self.assertEqual(
            _merge_detector_model_path("a", {"model_path": "/m"}, None), "/m"
        )

        with self.assertNoLogs(LOGGER_NAME, level=logging.WARNING):
            self.assertEqual(
                _merge_detector_model_path("b", {"model_path": "/m"}, "/m"), "/m"
            )

    def test_conflicting_model_path_keeps_first(self) -> None:
        with self.assertLogs(LOGGER_NAME, level=logging.WARNING) as logs:
            result = _merge_detector_model_path("b", {"model_path": "/other"}, "/m")

        self.assertEqual(result, "/m")
        self.assertIn("'b'", logs.output[0])
        self.assertIn("'/m'", logs.output[0])


class TestMigrateModelsEdges(unittest.TestCase):
    """Edge cases of folding detectors into models not covered elsewhere."""

    def test_null_detector_entry_is_a_cpu_detector(self) -> None:
        migrated = migrate_models({"detectors": {"cpu1": None}, "model": None})

        self.assertEqual(migrated["models"], [{"scene": "all", "devices": ["cpu"]}])
        self.assertNotIn("model", migrated)

    def test_unknown_detector_type_is_treated_as_shareable(self) -> None:
        migrated = migrate_models(
            {
                "detectors": {
                    "a": {"type": "madeup", "device": "x"},
                    "b": {"type": "madeup", "device": "x"},
                }
            }
        )

        self.assertEqual(migrated["models"][0]["devices"], ["madeup:x", "madeup:x"])

    def test_conflicting_model_paths_keep_the_first(self) -> None:
        with self.assertLogs(LOGGER_NAME, level=logging.WARNING):
            migrated = migrate_models(
                {
                    "detectors": {
                        "a": {"type": "cpu", "model_path": "/a.tflite"},
                        "b": {"type": "cpu", "model_path": "/b.tflite"},
                    }
                }
            )

        self.assertEqual(migrated["models"][0]["path"], "/a.tflite")
        self.assertEqual(migrated["models"][0]["devices"], ["cpu", "cpu"])


class TestGetRelativeCoordinates(unittest.TestCase):
    """Absolute pixel masks are converted to relative coordinates."""

    frame_shape = (100, 200)

    def test_empty_mask_is_returned_as_is(self) -> None:
        self.assertIsNone(get_relative_coordinates(None, self.frame_shape))
        self.assertEqual(get_relative_coordinates("", self.frame_shape), "")
        self.assertEqual(get_relative_coordinates([], self.frame_shape), [])

    def test_relative_string_is_unchanged(self) -> None:
        mask = "0.1,0.2,0.5,0.5"
        self.assertEqual(get_relative_coordinates(mask, self.frame_shape), mask)

    def test_absolute_string_is_converted(self) -> None:
        self.assertEqual(
            get_relative_coordinates("0,0,100,50,200,100", self.frame_shape),
            "0.0,0.0,0.5,0.5,1.0,1.0",
        )

    def test_out_of_bounds_string_is_dropped(self) -> None:
        with self.assertLogs(LOGGER_NAME, level=logging.ERROR) as logs:
            result = get_relative_coordinates("0,0,300,50", self.frame_shape, "front")

        self.assertEqual(result, [])
        self.assertIn("for camera front", logs.output[0])
        self.assertIn("200x100", logs.output[0])

    def test_relative_list_is_unchanged(self) -> None:
        mask = ["0.1,0.2,0.3,0.4"]
        self.assertEqual(get_relative_coordinates(mask, self.frame_shape), mask)

    def test_absolute_list_is_converted(self) -> None:
        result = get_relative_coordinates(
            ["20,10,200,100", "0.5,0.5,0.6,0.6"], self.frame_shape
        )

        self.assertEqual(result, ["0.1,0.1,1.0,1.0", "0.5,0.5,0.6,0.6"])

    def test_out_of_bounds_list_point_is_skipped(self) -> None:
        with self.assertLogs(LOGGER_NAME, level=logging.ERROR) as logs:
            result = get_relative_coordinates(["20,10,250,50,40,20"], self.frame_shape)

        self.assertEqual(result, ["0.1,0.1,0.2,0.2"])
        self.assertNotIn("for camera", logs.output[0])


class TestConvertAreaToPixels(unittest.TestCase):
    """Areas are pixel ints or fractional percentages of the frame."""

    def test_int_is_pixels(self) -> None:
        self.assertEqual(convert_area_to_pixels(500, (100, 100)), 500)

    def test_percentage_is_scaled(self) -> None:
        self.assertEqual(convert_area_to_pixels(0.5, (100, 200)), 10000)

    def test_tiny_percentage_is_at_least_one_pixel(self) -> None:
        self.assertEqual(convert_area_to_pixels(0.000001, (10, 10)), 1)

    def test_out_of_range_percentage_raises(self) -> None:
        with self.assertRaises(ValueError):
            convert_area_to_pixels(1.5, (100, 100))
        with self.assertRaises(ValueError):
            convert_area_to_pixels(0.0, (100, 100))

    def test_unexpected_type_raises(self) -> None:
        with self.assertRaises(TypeError):
            convert_area_to_pixels("10", (100, 100))  # type: ignore[arg-type]


class TestStreamInfoRetriever(unittest.TestCase):
    """Stream info is probed once per path and cached."""

    def test_results_are_cached_per_path(self) -> None:
        probe = AsyncMock(side_effect=[(1920, 1080), (640, 480)])
        retriever = StreamInfoRetriever()
        ffmpeg = MagicMock()

        with patch("frigate.util.config.get_video_properties", probe):
            first = retriever.get_stream_info(ffmpeg, "rtsp://a")
            again = retriever.get_stream_info(ffmpeg, "rtsp://a")
            other = retriever.get_stream_info(ffmpeg, "rtsp://b")

        self.assertEqual(first, (1920, 1080))
        self.assertEqual(again, (1920, 1080))
        self.assertEqual(other, (640, 480))
        self.assertEqual(probe.await_count, 2)
        probe.assert_any_await(ffmpeg, "rtsp://a")
        self.assertEqual(retriever.stream_cache["rtsp://b"], (640, 480))


class TestApplySectionUpdate(unittest.TestCase):
    """Section updates rebuild the runtime mask configs."""

    def setUp(self) -> None:
        config = {
            "mqtt": {"host": "mqtt"},
            "cameras": {
                "back": {
                    "ffmpeg": {
                        "inputs": [
                            {"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}
                        ]
                    },
                    "detect": {"height": 100, "width": 200, "fps": 5},
                    "motion": {
                        "mask": {
                            "m1": {
                                "friendly_name": "M1",
                                "enabled": True,
                                "coordinates": "0,0,0.5,0,0.5,0.5,0,0.5",
                            }
                        }
                    },
                    "objects": {
                        "track": ["person", "dog"],
                        "mask": {
                            "g1": {
                                "friendly_name": "G1",
                                "enabled": True,
                                "coordinates": "0,0,1,0,1,1",
                            }
                        },
                        "filters": {
                            "dog": {
                                "mask": {
                                    "d1": {
                                        "friendly_name": "D1",
                                        "enabled": True,
                                        "coordinates": "0,0,0.2,0,0.2,0.2",
                                    }
                                }
                            }
                        },
                    },
                    "zones": {
                        "yard": {
                            "coordinates": "0,0,0.5,0,0.5,0.5,0,0.5",
                            "filters": {"person": {"min_area": 0.1}},
                        },
                        "plain": {"coordinates": "0.5,0.5,1,0.5,1,1"},
                    },
                }
            },
        }
        self.camera = FrigateConfig(**config).cameras["back"]

    def test_missing_section(self) -> None:
        result = apply_section_update(self.camera, "not_a_section", {})
        self.assertEqual(result, "Section 'not_a_section' not found on camera 'back'")

    def test_motion_update_rebuilds_mask(self) -> None:
        result = apply_section_update(self.camera, "motion", {"threshold": 50})

        self.assertIsNone(result)
        self.assertEqual(self.camera.motion.threshold, 50)
        self.assertEqual(type(self.camera.motion).__name__, "RuntimeMotionConfig")
        self.assertEqual(self.camera.motion.rasterized_mask.shape, (100, 200))
        self.assertIn("m1", self.camera.motion.mask)

    def test_objects_update_merges_global_masks(self) -> None:
        result = apply_section_update(
            self.camera,
            "objects",
            {"filters": {"dog": {"min_score": 0.7}}},
        )

        self.assertIsNone(result)
        dog = self.camera.objects.filters["dog"]
        self.assertEqual(type(dog).__name__, "RuntimeFilterConfig")
        self.assertEqual(dog.min_score, 0.7)
        self.assertIn("d1", dog.mask)
        self.assertIn("global_g1", dog.mask)
        self.assertIsNotNone(dog.rasterized_mask)

    def test_detect_update_rescales_runtime_masks(self) -> None:
        result = apply_section_update(
            self.camera, "detect", {"width": 400, "height": 300}
        )

        self.assertIsNone(result)
        self.assertEqual(self.camera.frame_shape, (300, 400))
        self.assertEqual(self.camera.motion.rasterized_mask.shape, (300, 400))
        dog = self.camera.objects.filters["dog"]
        self.assertEqual(dog.rasterized_mask.shape, (300, 400))
        yard = self.camera.zones["yard"]
        self.assertEqual(type(yard.filters["person"]).__name__, "RuntimeFilterConfig")
        self.assertTrue(np.array_equal(yard.contour[1], [200, 0]))
        self.assertTrue(
            np.array_equal(self.camera.zones["plain"].contour[2], [400, 300])
        )

    def test_generic_section_update(self) -> None:
        result = apply_section_update(self.camera, "snapshots", {"enabled": True})

        self.assertIsNone(result)
        self.assertTrue(self.camera.snapshots.enabled)

    def test_validation_error_is_reported(self) -> None:
        with self.assertLogs(LOGGER_NAME, level=logging.ERROR):
            result = apply_section_update(
                self.camera, "snapshots", {"quality": "not-a-number"}
            )

        self.assertEqual(result, "Validation error. Check logs for details.")


class TestMigrateFrigateConfigFile(unittest.TestCase):
    """The file level migration across the version chain."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.config_file = os.path.join(self.temp_dir.name, "config.yml")
        self.export_dir = os.path.join(self.temp_dir.name, "exports")
        for name, value in (
            ("CONFIG_DIR", self.temp_dir.name),
            ("EXPORT_DIR", self.export_dir),
        ):
            patcher = patch.object(config_util, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _write(self, content: str) -> None:
        with open(self.config_file, "w") as f:
            f.write(content)

    def _load(self) -> Any:
        with open(self.config_file) as f:
            return YAML().load(f)

    def test_read_only_file_is_not_migrated(self) -> None:
        self._write("version: 0.13\n")

        with (
            patch("frigate.util.config.os.access", return_value=False),
            self.assertLogs(LOGGER_NAME, level=logging.ERROR) as logs,
        ):
            migrate_frigate_config(self.config_file)

        self.assertIn("read-only", logs.output[0])
        self.assertEqual(self._load(), {"version": 0.13})

    def test_empty_file_is_reported(self) -> None:
        self._write("")

        with self.assertLogs(LOGGER_NAME, level=logging.ERROR) as logs:
            migrate_frigate_config(self.config_file)

        self.assertIn("Failed to load config", logs.output[0])

    def test_full_chain_from_unversioned_config(self) -> None:
        os.mkdir(self.export_dir)
        open(os.path.join(self.export_dir, "front@2024.mp4"), "w").close()
        open(os.path.join(self.export_dir, "plain.mp4"), "w").close()

        self._write(
            "mqtt:\n"
            "  host: mqtt\n"
            "detectors:\n"
            "  coral:\n"
            "    type: edgetpu\n"
            "    device: usb\n"
            "    model:\n"
            "      path: /edgetpu.tflite\n"
            "cameras:\n"
            "  front:\n"
            "    record:\n"
            "      retain:\n"
            "        days: 3\n"
            "        mode: motion\n"
            "      events:\n"
            "        pre_capture: 4\n"
            "        retain:\n"
            "          default: 9\n"
            "    live:\n"
            "      stream_name: front_main\n"
            "    motion:\n"
            "      mask: 0,0,10,10,0,10\n"
            "    birdseye:\n"
            "      mode: objects\n"
        )

        migrate_frigate_config(self.config_file)
        migrated = self._load()

        self.assertEqual(migrated["version"], CURRENT_CONFIG_VERSION)
        self.assertTrue(
            os.path.exists(os.path.join(self.temp_dir.name, "backup_config.yaml"))
        )
        self.assertEqual(
            sorted(os.listdir(self.export_dir)), ["front_2024.mp4", "plain.mp4"]
        )
        self.assertNotIn("detectors", migrated)
        self.assertEqual(
            migrated["models"],
            [
                {
                    "scene": "all",
                    "path": "/edgetpu.tflite",
                    "devices": ["edgetpu:usb"],
                }
            ],
        )
        front = migrated["cameras"]["front"]
        self.assertEqual(
            front["record"]["alerts"], {"retain": {"days": 9}, "pre_capture": 4}
        )
        self.assertEqual(front["record"]["motion"], {"days": 3})
        self.assertNotIn("retain", front["record"])
        self.assertEqual(front["live"], {"streams": {"front_main": "front_main"}})
        self.assertEqual(
            front["motion"]["mask"]["motion_mask_1"]["coordinates"], "0,0,10,10,0,10"
        )
        self.assertEqual(front["birdseye"], {"modes": ["all_objects"]})

    def test_chain_from_0_18_without_export_dir(self) -> None:
        self._write(
            "mqtt:\n"
            "  host: mqtt\n"
            "models:\n"
            "  - devices:\n"
            "      - hailo8l:PCIe\n"
            "birdseye:\n"
            "  mode: motion\n"
            "cameras: {}\n"
            "version: 0.18-0\n"
        )

        migrate_frigate_config(self.config_file)
        migrated = self._load()

        self.assertEqual(migrated["version"], "0.19-0")
        self.assertEqual(migrated["birdseye"], {"modes": ["motion"]})
        self.assertEqual(migrated["models"][0]["devices"], ["hailo:PCIe"])

    def test_old_version_without_export_dir(self) -> None:
        self._write("mqtt:\n  host: mqtt\ncameras: {}\nversion: 0.13\n")

        migrate_frigate_config(self.config_file)
        migrated = self._load()

        self.assertFalse(os.path.exists(self.export_dir))
        self.assertEqual(migrated["version"], CURRENT_CONFIG_VERSION)
        self.assertNotIn("models", migrated)


if __name__ == "__main__":
    unittest.main(verbosity=2)
