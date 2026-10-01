"""HTTP tests for the app config, stats, labels, logs and timeline endpoints (fork D67)."""

import os
import shutil
import tempfile
from datetime import datetime
from subprocess import CompletedProcess
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

from frigate.api import app as app_api
from frigate.const import REDACTED_CREDENTIAL_SENTINEL
from frigate.models import Event, Recordings, ReviewSegment, Timeline
from frigate.stats.emitter import StatsEmitter
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp

_VIEWER = {"remote-user": "viewer", "remote-role": "viewer"}

_VALID_YAML = """mqtt:
  host: mqtt
cameras:
  front_door:
    ffmpeg:
      inputs:
        - path: rtsp://10.0.0.1:554/video
          roles:
            - detect
    detect:
      height: 1080
      width: 1920
      fps: 5
"""


class _AppHttpTestCase(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment, Timeline])
        self.stats = Mock(spec=StatsEmitter)
        self.stats.get_latest_stats.return_value = self.test_stats
        self.app = super().create_app(self.stats)
        self.tmp_dir = tempfile.mkdtemp()
        self.config_file = os.path.join(self.tmp_dir, "config.yml")

    def tearDown(self):
        self.app.dependency_overrides.clear()
        shutil.rmtree(self.tmp_dir, ignore_errors=True)
        super().tearDown()

    def _config_file(self, contents: str = _VALID_YAML):
        with open(self.config_file, "w") as f:
            f.write(contents)
        return patch.object(app_api, "find_config_file", return_value=self.config_file)


class TestPublicAndStats(_AppHttpTestCase):
    def test_health_version_and_schema(self):
        with AuthTestClient(self.app) as client:
            assert client.get("/").text == "Frigate is running. Alive and healthy!"
            assert client.get("/version").text == app_api.VERSION
            schema = client.get("/config/schema.json")
        assert schema.status_code == 200
        assert "properties" in schema.json()

    def test_stats_are_filtered_for_non_admins(self):
        self.stats.get_latest_stats.return_value = {
            "cameras": {"front_door": {"fps": 5}, "garage": {"fps": 5}},
            "bandwidth_usages": {"front_door": 1, "garage": 2},
            "cpu_usages": {"1": {"cpu": "2.0", "cmdline": "ffmpeg rtsp://secret"}},
        }
        with AuthTestClient(self.app) as client:
            response = client.get("/stats", headers=_VIEWER)

        body = response.json()
        assert list(body["cameras"]) == ["front_door"]
        assert list(body["bandwidth_usages"]) == ["front_door"]
        assert body["cpu_usages"] == {"1": {"cpu": "2.0"}}

    def test_stats_history_splits_keys(self):
        self.stats.get_stats_history.return_value = [{"cpu_usages": {}}]
        with AuthTestClient(self.app) as client:
            response = client.get("/stats/history", params={"keys": "cpu_usages,gpu"})
            client.get("/stats/history")
        assert response.json() == [{"cpu_usages": {}}]
        assert [c.args[0] for c in self.stats.get_stats_history.call_args_list] == [
            ["cpu_usages", "gpu"],
            None,
        ]

    def test_metrics(self):
        self.insert_mock_event("e1")
        with (
            patch.object(app_api, "update_metrics") as update,
            patch.object(
                app_api, "get_metrics", return_value=("frigate_up 1\n", "text/plain")
            ),
            patch.object(app_api, "model_metrics", return_value="models 1\n"),
            patch.object(app_api, "fork_camera_metrics", return_value="cams 1\n"),
            AuthTestClient(self.app) as client,
        ):
            response = client.get("/metrics")

        assert response.status_code == 200
        assert response.text == "frigate_up 1\nmodels 1\ncams 1\n"
        counts = list(update.call_args.kwargs["event_counts"])
        assert counts[0]["camera"] == "front_door"

    def test_genai_lists(self):
        self.app.genai_manager = MagicMock()
        self.app.genai_manager.list_models.return_value = {"main": ["m1"]}
        self.app.genai_manager.role_info.return_value = {"vision": {"model": "m1"}}
        with AuthTestClient(self.app) as client:
            assert client.get("/genai/models").json() == {"main": ["m1"]}
            assert client.get("/genai/roles").json() == {"vision": {"model": "m1"}}

    def test_genai_probe_unknown_provider(self):
        with (
            patch.object(app_api, "load_providers"),
            AuthTestClient(self.app) as client,
        ):
            with patch.dict(app_api.PROVIDERS, {}, clear=True):
                unknown = client.post("/genai/probe", json={"provider": "openai"})
        assert unknown.status_code == 400
        assert unknown.json()["message"] == "Unknown provider"

    def test_genai_probe_client_errors(self):
        broken_ctor = Mock(side_effect=RuntimeError("bad key"))
        slow_client = Mock()
        slow_client.return_value.list_models.side_effect = TimeoutError()

        with (
            patch.object(app_api, "load_providers"),
            AuthTestClient(self.app) as client,
        ):
            with patch.dict(app_api.PROVIDERS, {"openai": broken_ctor}):
                construct = client.post(
                    "/genai/probe", json={"provider": "openai", "api_key": "k"}
                )
            with patch.dict(app_api.PROVIDERS, {"openai": slow_client}):
                timeout = client.post(
                    "/genai/probe", json={"provider": "openai", "api_key": "k"}
                )

        assert construct.json()["message"] == "Failed to connect to provider"
        assert timeout.json()["message"] == "Probe timed out"
        options = slow_client.call_args.args[0].provider_options
        assert options["timeout"] == app_api._PROBE_TIMEOUT_SECONDS


class TestConfigEndpoints(_AppHttpTestCase):
    def test_config_redacts_secrets_and_cleans_paths(self):
        self.minimal_config["cameras"]["front_door"]["ffmpeg"]["inputs"][0]["path"] = (
            "rtsp://user:secret@10.0.0.1:554/video"
        )
        self.minimal_config["cameras"]["front_door"]["onvif"] = {
            "host": "10.0.0.1",
            "user": "admin",
            "password": "onvif-secret",
        }
        self.minimal_config["cameras"]["front_door"]["zones"] = {
            "porch": {"coordinates": "0,0,1,0,1,1,0,1"}
        }
        self.minimal_config["go2rtc"] = {
            "streams": {
                "single": "rtsp://user:secret@10.0.0.1/a",
                "multi": ["rtsp://user:secret@10.0.0.1/b", "ffmpeg:single#audio=aac"],
            }
        }
        self.minimal_config["environment_vars"] = {"TZ": "UTC"}
        self.app = super().create_app(self.stats)

        with AuthTestClient(self.app) as client:
            admin = client.get("/config").json()
            viewer = client.get("/config", headers=_VIEWER).json()

        camera = admin["cameras"]["front_door"]
        assert "secret" not in camera["ffmpeg"]["inputs"][0]["path"]
        assert camera["onvif"]["password"] == REDACTED_CREDENTIAL_SENTINEL
        assert all("secret" not in c["cmd"] for c in camera["ffmpeg_cmds"])
        assert "color" in camera["zones"]["porch"]
        assert "secret" not in admin["go2rtc"]["streams"]["single"]
        assert "secret" not in admin["go2rtc"]["streams"]["multi"][0]
        assert admin["plus"] == {"enabled": False}
        assert "labelmap" in admin["models"][0]
        assert admin["environment_vars"] == {"TZ": "UTC"}
        assert "environment_vars" not in viewer

    def test_config_includes_plus_model_info(self):
        with (
            patch.object(
                type(self.app.frigate_config.plus_api), "is_active", return_value=True
            ),
            AuthTestClient(self.app) as client,
        ):
            body = client.get("/config").json()
        assert body["plus"] == {"enabled": True}
        assert "plus" in body["models"][0]

    def test_config_raw_paths_returns_unmasked_values(self):
        self.minimal_config["cameras"]["front_door"]["ffmpeg"]["inputs"][0]["path"] = (
            "rtsp://user:secret@10.0.0.1:554/video"
        )
        self.minimal_config["go2rtc"] = {"streams": {"door": "rtsp://u:pw@10.0.0.1/a"}}
        self.app = super().create_app(self.stats)

        with AuthTestClient(self.app) as client:
            body = client.get("/config/raw_paths").json()

        assert body["cameras"]["front_door"]["ffmpeg"]["inputs"][0]["path"] == (
            "rtsp://user:secret@10.0.0.1:554/video"
        )
        assert body["go2rtc"]["streams"]["door"] == "rtsp://u:pw@10.0.0.1/a"

    def test_profiles_and_presets(self):
        self.app.profile_manager = MagicMock()
        self.app.profile_manager.get_profile_info.return_value = {
            "profiles": [],
            "active_profile": None,
            "last_activated": {},
        }
        with AuthTestClient(self.app) as client:
            profiles = client.get("/profiles")
            active = client.get("/profile/active")
            with patch.object(app_api.platform, "machine", return_value="aarch64"):
                arm = client.get("/ffmpeg/presets").json()
            with patch.object(app_api.platform, "machine", return_value="x86_64"):
                x86 = client.get("/ffmpeg/presets").json()

        assert profiles.json()["profiles"] == []
        assert active.json() == {"active_profile": None}
        assert "preset-rpi-64-h264" in arm["hwaccel_args"]
        assert "preset-nvidia" in x86["hwaccel_args"]
        assert "preset-record-generic" in x86["output_args"]["record"]

    def test_config_raw(self):
        with AuthTestClient(self.app) as client:
            with self._config_file("mqtt:\n  host: mqtt\n"):
                found = client.get("/config/raw")
            with patch.object(
                app_api, "find_config_file", return_value="/nonexistent/config.yml"
            ):
                missing = client.get("/config/raw")
        assert found.status_code == 200
        assert found.json() == "mqtt:\n  host: mqtt\n"
        assert missing.status_code == 404

    def test_config_save_writes_file(self):
        with self._config_file("old: true\n"), AuthTestClient(self.app) as client:
            saved = client.post(
                "/config/save",
                params={"save_option": "saveonly"},
                content=_VALID_YAML,
                headers={"content-type": "text/plain"},
            )
            with patch.object(app_api, "restart_frigate") as restart:
                restarted = client.post(
                    "/config/save",
                    params={"save_option": "restart"},
                    content=_VALID_YAML,
                    headers={"content-type": "text/plain"},
                )
            with patch.object(
                app_api, "restart_frigate", side_effect=RuntimeError("no s6")
            ):
                restart_failed = client.post(
                    "/config/save",
                    params={"save_option": "restart"},
                    content=_VALID_YAML,
                    headers={"content-type": "text/plain"},
                )

        assert saved.json()["message"] == "Config successfully saved."
        assert "restarting" in restarted.json()["message"]
        restart.assert_called_once()
        assert "unable to restart" in restart_failed.json()["message"]
        with open(self.config_file) as f:
            assert f.read() == _VALID_YAML

    def test_config_save_rejects_invalid_yaml(self):
        invalid = _VALID_YAML.replace("fps: 5", "fps: lots")
        with self._config_file("old: true\n"), AuthTestClient(self.app) as client:
            schema_error = client.post(
                "/config/save",
                params={"save_option": "saveonly"},
                content=invalid,
                headers={"content-type": "text/plain"},
            )
            parse_error = client.post(
                "/config/save",
                params={"save_option": "saveonly"},
                content="cameras: [unclosed",
                headers={"content-type": "text/plain"},
            )

        assert schema_error.status_code == 400
        assert (
            "cameras -> front_door -> detect -> fps" in schema_error.json()["message"]
        )
        # ruamel line numbers are zero based
        assert "Line 10" in schema_error.json()["message"]
        assert parse_error.status_code == 400
        with open(self.config_file) as f:
            assert f.read() == "old: true\n"

    def test_config_save_write_failure(self):
        with (
            patch.object(
                app_api, "find_config_file", return_value="/nonexistent/dir/c.yml"
            ),
            AuthTestClient(self.app) as client,
        ):
            response = client.post(
                "/config/save",
                params={"save_option": "saveonly"},
                content=_VALID_YAML,
                headers={"content-type": "text/plain"},
            )
        assert response.status_code == 400
        assert "Could not write config file" in response.json()["message"]


class TestConfigSetInMemory(_AppHttpTestCase):
    def setUp(self):
        super().setUp()
        self.app.config_publisher = MagicMock()

    def _set(self, client, body: dict):
        with self._config_file():
            return client.put("/config/set", json={"skip_save": True, **body})

    def test_requires_config_data(self):
        with AuthTestClient(self.app) as client:
            response = self._set(client, {})
            sentinel_only = self._set(
                client,
                {
                    "config_data": {
                        "cameras": {
                            "front_door": {
                                "onvif": {"password": REDACTED_CREDENTIAL_SENTINEL}
                            }
                        }
                    }
                },
            )
        assert response.status_code == 400
        assert sentinel_only.status_code == 400

    def test_unknown_camera(self):
        with AuthTestClient(self.app) as client:
            response = self._set(
                client,
                {"config_data": {"cameras": {"garage": {"motion": {"threshold": 9}}}}},
            )
        assert response.status_code == 400
        assert response.json()["message"] == "Camera 'garage' not found"

    def test_detect_update_republishes_dependent_sections(self):
        self.minimal_config["cameras"]["front_door"]["zones"] = {
            "porch": {"coordinates": "0,0,1,0,1,1,0,1"}
        }
        self.minimal_config["cameras"]["front_door"]["ffmpeg"]["inputs"][0]["path"] = (
            "rtsp://user:secret@10.0.0.1:554/video"
        )
        self.app = super().create_app(self.stats)
        self.app.config_publisher = MagicMock()

        with AuthTestClient(self.app) as client:
            response = self._set(
                client,
                {
                    "config_data": {
                        "cameras": {
                            "front_door": {
                                "detect": {"fps": 7},
                                "motion": {"threshold": 40},
                                "ffmpeg": {
                                    "inputs": [
                                        {
                                            "path": "rtsp://*:*@10.0.0.1:554/video",
                                            "roles": ["detect"],
                                        }
                                    ]
                                },
                            }
                        }
                    },
                    "update_topic": "config/cameras/front_door/detect",
                },
            )

        assert response.status_code == 200
        camera = self.app.frigate_config.cameras["front_door"]
        assert camera.detect.fps == 7
        assert camera.motion.threshold == 40
        assert camera.ffmpeg.inputs[0].path == "rtsp://user:secret@10.0.0.1:554/video"
        topics = [
            c.args[0].update_type.name
            for c in self.app.config_publisher.publish_update.call_args_list
        ]
        assert topics == ["detect", "motion", "objects", "zones", "refresh"]

    def test_section_update_error(self):
        with (
            patch.object(app_api, "apply_section_update", return_value="bad value"),
            AuthTestClient(self.app) as client,
        ):
            response = self._set(
                client,
                {"config_data": {"cameras": {"front_door": {"motion": {"x": 1}}}}},
            )
        assert response.status_code == 400
        assert response.json()["message"] == "bad value"

    def test_unexpected_error(self):
        with (
            patch.object(app_api, "apply_section_update", side_effect=RuntimeError()),
            AuthTestClient(self.app) as client,
        ):
            response = self._set(
                client,
                {"config_data": {"cameras": {"front_door": {"motion": {"x": 1}}}}},
            )
        assert response.status_code == 500


class TestConfigSetToFile(_AppHttpTestCase):
    def test_query_string_update_and_restart_message(self):
        with self._config_file(), AuthTestClient(self.app) as client:
            response = client.put(
                "/config/set?cameras.front_door.detect.fps=7", json={}
            )

        assert response.status_code == 200
        assert response.json()["message"] == (
            "Config successfully updated, restart to apply"
        )
        with open(self.config_file) as f:
            assert "fps: 7" in f.read()

    def test_no_updates(self):
        with self._config_file(), AuthTestClient(self.app) as client:
            response = client.put("/config/set", json={})
        assert response.status_code == 400

    def test_invalid_update_restores_file(self):
        with self._config_file(), AuthTestClient(self.app) as client:
            response = client.put(
                "/config/set",
                json={
                    "config_data": {"cameras": {"front_door": {"detect": {"fps": "x"}}}}
                },
            )
        assert response.status_code == 400
        assert response.json()["message"].startswith("Error saving config:")
        with open(self.config_file) as f:
            assert f.read() == _VALID_YAML

    def test_parse_error_restores_file(self):
        with (
            self._config_file(),
            patch.object(
                app_api.FrigateConfig, "parse", side_effect=RuntimeError("boom")
            ),
            AuthTestClient(self.app) as client,
        ):
            response = client.put(
                "/config/set",
                json={
                    "config_data": {"cameras": {"front_door": {"detect": {"fps": 6}}}}
                },
            )
        assert response.status_code == 400
        assert "Error parsing config" in response.json()["message"]
        with open(self.config_file) as f:
            assert f.read() == _VALID_YAML

    def test_update_failure(self):
        with (
            self._config_file(),
            patch.object(
                app_api, "update_yaml_file_bulk", side_effect=RuntimeError("disk")
            ),
            AuthTestClient(self.app) as client,
        ):
            response = client.put(
                "/config/set",
                json={
                    "config_data": {"cameras": {"front_door": {"detect": {"fps": 6}}}}
                },
            )
        assert response.status_code == 500

    def test_lock_timeout(self):
        lock = MagicMock()
        lock.__enter__.side_effect = app_api.Timeout("config.yml.lock")
        with (
            self._config_file(),
            patch.object(app_api, "FileLock", return_value=lock),
            AuthTestClient(self.app) as client,
        ):
            response = client.put(
                "/config/set",
                json={
                    "config_data": {"cameras": {"front_door": {"detect": {"fps": 6}}}}
                },
            )
        assert response.status_code == 503

    def test_add_and_remove_camera_topics_publish_camera(self):
        self.app.config_publisher = MagicMock()
        self.app.stats_emitter = MagicMock()
        with self._config_file(), AuthTestClient(self.app) as client:
            response = client.put(
                "/config/set",
                json={
                    "requires_restart": 0,
                    "config_data": {"cameras": {"front_door": {"detect": {"fps": 6}}}},
                    "update_topic": "config/cameras/front_door/add",
                },
            )
            removed = client.put(
                "/config/set",
                json={
                    "requires_restart": 0,
                    "config_data": {"cameras": {"front_door": {"detect": {"fps": 4}}}},
                    "update_topic": "config/cameras/front_door/remove",
                },
            )

        assert response.json()["message"] == "Config successfully updated"
        assert removed.status_code == 200
        published = self.app.config_publisher.publish_update.call_args_list
        assert [c.args[0].update_type.name for c in published] == ["add", "remove"]
        assert published[0].args[1].detect.fps == 6
        assert published[1].args[1].detect.fps == 6


class TestSystemEndpoints(_AppHttpTestCase):
    def test_vainfo(self):
        with AuthTestClient(self.app) as client:
            with (
                patch.object(
                    app_api._gpu_selector, "get_gpu_arg", side_effect=RuntimeError()
                ),
                patch.object(
                    app_api,
                    "vainfo_hwaccel",
                    return_value=CompletedProcess([], 0, b"VA-API ok\n", b""),
                ) as vainfo,
            ):
                ok = client.get("/vainfo").json()
            with patch.object(
                app_api,
                "vainfo_hwaccel",
                return_value=CompletedProcess([], 1, b"", b"no device\n"),
            ):
                failed = client.get("/vainfo").json()

        assert vainfo.call_args.kwargs["device_name"] is None
        assert ok == {"return_code": 0, "stderr": "", "stdout": "VA-API ok"}
        assert failed == {"return_code": 1, "stderr": "no device", "stdout": ""}

    def test_nvinfo(self):
        with (
            patch.object(app_api, "get_nvidia_driver_info", return_value={"v": "550"}),
            AuthTestClient(self.app) as client,
        ):
            assert client.get("/nvinfo").json() == {"v": "550"}

    def test_logs(self):
        log_file = os.path.join(self.tmp_dir, "current")
        with open(log_file, "w") as f:
            f.write(
                "2024-01-01 00:00:00.000000000  [INFO] one\n"
                "2024-01-01 00:00:01.000000000  [INFO] two\n"
            )

        def redirect(path: str) -> str:
            return log_file if path == "/dev/shm/logs/frigate/current" else path

        real_aio_open = app_api.aiofiles.open
        real_open = open

        with (
            patch.object(
                app_api.aiofiles,
                "open",
                side_effect=lambda path, *a, **k: real_aio_open(
                    redirect(path), *a, **k
                ),
            ),
            patch(
                "frigate.api.app.open",
                create=True,
                side_effect=lambda path, *a, **k: real_open(redirect(path), *a, **k),
            ),
            AuthTestClient(self.app) as client,
        ):
            full = client.get("/logs/frigate")
            page = client.get("/logs/frigate", params={"start": 1, "end": 2})
            downloaded = client.get("/logs/frigate", params={"download": "1"})
            missing = client.get("/logs/nginx")
            downloaded_missing = client.get("/logs/go2rtc", params={"download": "1"})
            invalid = client.get("/logs/bogus")

        assert full.json()["totalLines"] == 2
        assert len(full.json()["lines"]) == 2
        assert len(page.json()["lines"]) == 1
        assert "[INFO] two" in downloaded.json()
        assert missing.status_code == 500
        assert downloaded_missing.status_code == 500
        assert invalid.status_code == 404

    def test_restart(self):
        with AuthTestClient(self.app) as client:
            with patch.object(app_api, "restart_frigate") as restart:
                ok = client.post("/restart")
            with patch.object(
                app_api, "restart_frigate", side_effect=RuntimeError("no s6")
            ):
                failed = client.post("/restart")
        restart.assert_called_once()
        assert ok.status_code == 200
        assert failed.status_code == 500

    def test_media_sync_jobs(self):
        job = SimpleNamespace(id="job-1", to_dict=lambda: {"id": "job-1"})
        with AuthTestClient(self.app) as client:
            with patch.object(app_api, "start_media_sync_job", return_value="job-1"):
                started = client.post("/media/sync", json={"dry_run": True})
            with (
                patch.object(app_api, "start_media_sync_job", return_value=None),
                patch.object(app_api, "get_current_media_sync_job", return_value=job),
            ):
                busy = client.post("/media/sync", json={})
            with patch.object(app_api, "get_current_media_sync_job", return_value=None):
                idle = client.get("/media/sync/current")
            with patch.object(app_api, "get_current_media_sync_job", return_value=job):
                current = client.get("/media/sync/current")
            with patch.object(app_api, "get_media_sync_job_by_id", return_value=None):
                missing = client.get("/media/sync/status/nope")
            with patch.object(app_api, "get_media_sync_job_by_id", return_value=job):
                found = client.get("/media/sync/status/job-1")

        assert started.status_code == 202
        assert started.json()["job"]["id"] == "job-1"
        assert busy.status_code == 409
        assert busy.json()["current_job_id"] == "job-1"
        assert idle.json() == {"job": None}
        assert current.json() == {"job": {"id": "job-1"}}
        assert missing.status_code == 404
        assert found.json() == {"job": {"id": "job-1"}}


class TestLabelsAndTimeline(_AppHttpTestCase):
    def setUp(self):
        super().setUp()
        self.minimal_config["cameras"]["garage"] = {
            "ffmpeg": {
                "inputs": [{"path": "rtsp://10.0.0.2:554/video", "roles": ["detect"]}]
            },
            "detect": {"height": 1080, "width": 1920, "fps": 5},
        }
        self.app = super().create_app(self.stats)

    def _event(
        self, id, camera="front_door", label="person", sub_label=None, data=None
    ):
        self.insert_mock_event(id, camera=camera, data=data or {})
        Event.update(label=label, sub_label=sub_label).where(Event.id == id).execute()

    def test_labels(self):
        self._event("e1", label="person")
        self._event("e2", label="car", camera="garage")
        with AuthTestClient(self.app) as client:
            assert client.get("/labels").json() == ["car", "person"]
            assert client.get("/labels", params={"camera": "garage"}).json() == ["car"]
            denied = client.get("/labels", params={"camera": "attic"})
        assert denied.status_code == 403

    def test_sub_labels(self):
        self._event("e1", sub_label="Bob, Alice")
        self._event("e2", sub_label="Carl")
        self._event("e3")
        with AuthTestClient(self.app) as client:
            joined = client.get("/sub_labels").json()
            split = client.get("/sub_labels", params={"split_joined": 1}).json()
        assert joined == ["Bob, Alice", "Carl"]
        assert split == ["Alice", "Bob", "Carl"]

    def test_recognized_license_plates(self):
        self._event("e1", data={"recognized_license_plate": "ABC, XYZ"})
        self._event("e2", data={"recognized_license_plate": "DEF"})
        self._event("e3", data={"recognized_license_plate": "DEF"})
        with AuthTestClient(self.app) as client:
            joined = client.get("/recognized_license_plates").json()
            split = client.get(
                "/recognized_license_plates", params={"split_joined": 1}
            ).json()
        assert joined == ["ABC, XYZ", "DEF"]
        assert split == ["ABC", "DEF", "XYZ"]

    def test_audio_labels_include_configured_overrides(self):
        self.minimal_config["audio"] = {"labelmap": {"900": "doorbell"}}
        self.app = super().create_app(self.stats)
        with (
            patch.object(app_api, "load_labels", return_value={0: "speech"}),
            AuthTestClient(self.app) as client,
        ):
            labels = client.get("/audio_labels").json()
        assert labels["0"] == "speech"
        assert labels["900"] == "doorbell"

    def test_categorized_object_names(self):
        with (
            patch.object(
                app_api,
                "get_categorized_object_names",
                return_value={"person": ["Bob"]},
            ) as names,
            AuthTestClient(self.app) as client,
        ):
            response = client.get(
                "/categorized_object_names", params={"object_type": "person"}
            )
        assert response.json() == {"person": ["Bob"]}
        assert names.call_args.args[2] == "person"

    def test_plus_models(self):
        plus = self.app.frigate_config.plus_api
        models = {
            "list": [
                {
                    "id": "old",
                    "trainDate": "2024-01-01",
                    "supportedDetectors": ["cpu"],
                    "type": "ssd",
                },
                {
                    "id": "new",
                    "trainDate": "2025-01-01",
                    "supportedDetectors": ["edgetpu"],
                    "type": "yolonas",
                },
            ]
        }
        with AuthTestClient(self.app) as client:
            disabled = client.get("/plus/models")
            with (
                patch.object(type(plus), "is_active", return_value=True),
                patch.object(type(plus), "get_models", return_value={"list": []}),
            ):
                empty = client.get("/plus/models")
            with (
                patch.object(type(plus), "is_active", return_value=True),
                patch.object(type(plus), "get_models", return_value=models),
            ):
                all_models = client.get("/plus/models").json()
                filtered = client.get(
                    "/plus/models", params={"filterByCurrentModelDetector": True}
                ).json()

        assert disabled.status_code == 400
        assert empty.status_code == 400
        assert empty.json()["message"] == "No models found"
        assert [m["id"] for m in all_models] == ["new", "old"]
        assert [m["id"] for m in filtered] == ["old"]

    def _timeline(self, ts: float, camera="front_door", source_id="s1", label="person"):
        Timeline.insert(
            timestamp=ts,
            camera=camera,
            source="tracked_object",
            source_id=source_id,
            class_type="visible",
            data={"label": label},
        ).execute()

    def test_timeline_filters(self):
        self._timeline(100.0, source_id="a")
        self._timeline(200.0, source_id="b")
        self._timeline(300.0, camera="garage", source_id="c")
        with AuthTestClient(self.app) as client:
            all_rows = client.get("/timeline").json()
            camera = client.get("/timeline", params={"camera": "garage"}).json()
            one = client.get("/timeline", params={"source_id": "b"}).json()
            many = client.get("/timeline", params={"source_id": "a, c"}).json()

        assert [r["source_id"] for r in all_rows] == ["a", "b", "c"]
        assert [r["source_id"] for r in camera] == ["c"]
        assert [r["source_id"] for r in one] == ["b"]
        assert [r["source_id"] for r in many] == ["a", "c"]

    def test_hourly_timeline(self):
        base = datetime(2024, 5, 1, 10, 0).timestamp()
        self._timeline(base + 60, source_id="a")
        self._timeline(base + 120, source_id="b", label="car")
        self._timeline(base + 3700, source_id="c")
        self._timeline(base + 3800, camera="garage", source_id="d")

        with AuthTestClient(self.app) as client:
            body = client.get(
                "/timeline/hourly",
                params={
                    "cameras": "front_door",
                    "labels": "person",
                    "after": base,
                    "before": base + 7200,
                },
            ).json()
            empty = client.get("/timeline/hourly", params={"before": 1}).json()

        assert body["count"] == 2
        assert body["start"] == base + 3700
        assert body["end"] == base + 60
        assert sorted(len(v) for v in body["hours"].values()) == [1, 1]
        assert empty == {"start": 0, "end": 0, "count": 0, "hours": {}}
