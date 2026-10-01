"""HTTP tests for the camera, go2rtc, ffprobe, Reolink and ONVIF endpoints (fork D67)."""

import json
from subprocess import CompletedProcess
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import requests
from onvif import ONVIFError
from urllib3.exceptions import HTTPError
from urllib3.exceptions import TimeoutError as CameraTimeoutError
from zeep.exceptions import Fault

from frigate.api import camera as camera_api
from frigate.models import Event, Recordings, ReviewSegment
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp


def _response(ok: bool = True, payload=None, status: int = 200, text: str = ""):
    response = MagicMock()
    response.ok = ok
    response.status_code = status
    response.text = text
    response.json.return_value = payload if payload is not None else {}
    return response


def _probe(returncode: int = 0, stdout: dict | None = None, stderr: bytes = b""):
    return CompletedProcess(
        args=[],
        returncode=returncode,
        stdout=json.dumps(stdout or {}).encode(),
        stderr=stderr,
    )


class _CameraHttpTestCase(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment])
        self.app = super().create_app()

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()


class TestGo2rtcStreams(_CameraHttpTestCase):
    def test_list_streams_scrubs_producer_credentials(self):
        streams = {
            "front_door": {
                "producers": [{"url": "rtsp://user:secret@10.0.0.1:554/video"}]
            },
            "idle": {"producers": None},
        }
        with (
            patch.object(
                camera_api.requests, "get", return_value=_response(payload=streams)
            ),
            AuthTestClient(self.app) as client,
        ):
            response = client.get("/go2rtc/streams")

        assert response.status_code == 200
        url = response.json()["front_door"]["producers"][0]["url"]
        assert "secret" not in url

    def test_list_streams_go2rtc_failure(self):
        with (
            patch.object(camera_api.requests, "get", return_value=_response(False)),
            AuthTestClient(self.app) as client,
        ):
            response = client.get("/go2rtc/streams")
        assert response.status_code == 500

    def test_list_streams_filters_by_role_cameras(self):
        self.minimal_config["auth"] = {"roles": {"porch": ["front_door"]}}
        self.minimal_config["cameras"]["back"] = {
            "ffmpeg": {
                "inputs": [{"path": "rtsp://10.0.0.2:554/video", "roles": ["detect"]}]
            },
            "detect": {"height": 1080, "width": 1920, "fps": 5},
        }
        self.app = super().create_app()
        streams = {"front_door": {}, "back": {}}
        with (
            patch.object(
                camera_api.requests, "get", return_value=_response(payload=streams)
            ),
            AuthTestClient(self.app) as client,
        ):
            response = client.get(
                "/go2rtc/streams",
                headers={"remote-user": "viewer", "remote-role": "porch"},
            )
        assert list(response.json()) == ["front_door"]

    def test_get_single_stream(self):
        stream = {"producers": [{"url": "rtsp://u:p@10.0.0.1/s"}]}
        with (
            patch.object(
                camera_api.requests, "get", return_value=_response(payload=stream)
            ) as get,
            AuthTestClient(self.app) as client,
        ):
            response = client.get("/go2rtc/streams/front_door")

        assert response.status_code == 200
        assert ":p@" not in response.json()["producers"][0]["url"]
        assert get.call_args.kwargs["params"]["src"] == "front_door"

    def test_get_single_stream_failures(self):
        with AuthTestClient(self.app) as client:
            with patch.object(
                camera_api.requests,
                "get",
                side_effect=requests.ConnectionError("refused"),
            ):
                unreachable = client.get("/go2rtc/streams/front_door")
            with patch.object(
                camera_api.requests, "get", return_value=_response(False)
            ):
                not_ok = client.get("/go2rtc/streams/front_door")
        assert unreachable.status_code == 500
        assert not_ok.status_code == 500

    def test_add_stream(self):
        with (
            patch.object(camera_api.requests, "put", return_value=_response()) as put,
            AuthTestClient(self.app) as client,
        ):
            response = client.put(
                "/go2rtc/streams/porch", params={"src": "rtsp://10.0.0.9/live"}
            )
            no_src = client.put("/go2rtc/streams/porch")

        assert response.json()["success"] is True
        assert no_src.status_code == 200
        assert put.call_args_list[0].kwargs["params"] == {
            "name": "porch",
            "src": "rtsp://10.0.0.9/live",
        }
        assert put.call_args_list[1].kwargs["params"] == {"name": "porch"}

    def test_add_stream_rejects_restricted_sources(self):
        with (
            patch.object(camera_api.requests, "put") as put,
            AuthTestClient(self.app) as client,
        ):
            response = client.put("/go2rtc/streams/x", params={"src": "exec:ls"})
        assert response.status_code == 400
        put.assert_not_called()

    def test_add_stream_rejects_restricted_source_after_substitution(self):
        with (
            patch.object(camera_api, "substitute_frigate_vars", return_value="echo:hi"),
            patch.object(camera_api.requests, "put") as put,
            AuthTestClient(self.app) as client,
        ):
            response = client.put("/go2rtc/streams/x", params={"src": "{FRIGATE_SRC}"})
        assert response.status_code == 400
        put.assert_not_called()

    def test_add_stream_go2rtc_errors(self):
        with AuthTestClient(self.app) as client:
            with patch.object(
                camera_api.requests,
                "put",
                return_value=_response(False, status=422, text="bad"),
            ):
                rejected = client.put("/go2rtc/streams/x", params={"src": "rtsp://a"})
            with patch.object(
                camera_api.requests, "put", side_effect=requests.Timeout()
            ):
                unreachable = client.put("/go2rtc/streams/x")
        assert rejected.status_code == 422
        assert rejected.json()["message"] == "Failed to add stream: bad"
        assert unreachable.status_code == 500

    def test_delete_stream(self):
        with AuthTestClient(self.app) as client:
            with patch.object(
                camera_api.requests, "delete", return_value=_response()
            ) as delete:
                ok = client.delete("/go2rtc/streams/porch")
            with patch.object(
                camera_api.requests,
                "delete",
                return_value=_response(False, status=404, text="nope"),
            ):
                missing = client.delete("/go2rtc/streams/porch")
            with patch.object(
                camera_api.requests, "delete", side_effect=requests.Timeout()
            ):
                unreachable = client.delete("/go2rtc/streams/porch")

        assert ok.json()["message"] == "Stream deleted successfully"
        assert delete.call_args.kwargs["params"] == {"src": "porch"}
        assert missing.status_code == 404
        assert unreachable.status_code == 500


class TestFfprobe(_CameraHttpTestCase):
    def test_requires_path(self):
        with AuthTestClient(self.app) as client:
            assert client.get("/ffprobe").status_code == 404
            assert (
                client.get("/ffprobe", params={"paths": "camera:missing"}).status_code
                == 404
            )

    def test_disabled_camera(self):
        self.app.frigate_config.cameras["front_door"].enabled = False
        with AuthTestClient(self.app) as client:
            response = client.get("/ffprobe", params={"paths": "camera:front_door"})
        assert response.json()["message"] == "front_door is not enabled."

    def test_multiple_paths_with_detailed_metadata(self):
        stdout = {
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "width": 1920,
                    "height": 1080,
                    "avg_frame_rate": "30/1",
                    "pix_fmt": "yuv420p",
                },
                {"codec_type": "audio", "codec_name": "aac", "channels": 1},
            ],
            "format": {"format_name": "rtsp", "duration": "N/A"},
        }
        with (
            patch.object(
                camera_api,
                "ffprobe_stream",
                side_effect=[_probe(stdout=stdout), _probe(1, stderr=b"\xff boom")],
            ) as probe,
            AuthTestClient(self.app) as client,
        ):
            response = client.get(
                "/ffprobe",
                params={"paths": "rtsp://a/1,rtsp://b/2", "detailed": True},
            )

        assert [c.args[1] for c in probe.call_args_list] == [
            "rtsp://a/1",
            "rtsp://b/2",
        ]
        first, second = response.json()
        assert first["metadata"]["video"]["resolution"] == "1920x1080"
        assert first["metadata"]["video"]["fps"] == 30.0
        assert first["metadata"]["audio"]["codec"] == "aac"
        assert first["metadata"]["container"]["format"] == "rtsp"
        assert second["return_code"] == 1
        # invalid utf-8 falls back to the unicode_escape decoding
        assert second["stderr"] == ["\xff boom"]

    def test_extract_fps(self):
        assert camera_api._extract_fps("") is None
        assert camera_api._extract_fps("25/0") is None
        assert camera_api._extract_fps("bad") is None
        assert camera_api._extract_fps("30000/1001") == 29.97

    def test_ffprobe_snapshot(self):
        with AuthTestClient(self.app) as client:
            assert client.get("/ffprobe/snapshot").status_code == 400
            with patch.object(
                camera_api, "run_ffmpeg_snapshot", return_value=(b"jpeg", None)
            ):
                ok = client.get("/ffprobe/snapshot", params={"url": "rtsp://a"})
            with patch.object(
                camera_api, "run_ffmpeg_snapshot", return_value=(None, "timeout")
            ):
                timed_out = client.get("/ffprobe/snapshot", params={"url": "rtsp://a"})
            with patch.object(
                camera_api, "run_ffmpeg_snapshot", return_value=(None, "exit 1")
            ):
                failed = client.get("/ffprobe/snapshot", params={"url": "rtsp://a"})

        assert ok.status_code == 200
        assert ok.content == b"jpeg"
        assert ok.headers["content-type"] == "image/jpeg"
        assert timed_out.status_code == 408
        assert failed.status_code == 500

    def test_keyframe_analysis_disabled_camera(self):
        self.app.frigate_config.cameras["front_door"].enabled = False
        with AuthTestClient(self.app) as client:
            response = client.get("/keyframe_analysis", params={"camera": "front_door"})
        assert response.status_code == 404


class TestReolinkDetect(_CameraHttpTestCase):
    def setUp(self):
        self.reolink_target = "cam.local"
        super().setUp()

    def _app_with_target(self):
        self.minimal_config["networking"] = {
            "reolink_targets": {self.reolink_target: {"address": "10.0.0.50"}}
        }
        self.app = super().create_app()

    def _detect(self, client, **params):
        query = {"host": self.reolink_target, "username": "admin", "password": "pw"}
        query.update(params)
        return client.get("/reolink/detect", params=query)

    def test_parameter_validation(self):
        with AuthTestClient(self.app) as client:
            assert self._detect(client, host="").status_code == 400
            assert self._detect(client, username="").status_code == 400
            assert self._detect(client, password="").status_code == 400
            assert self._detect(client, host="a/b").status_code == 400
            assert self._detect(client, host="a:99999").status_code == 400
            assert self._detect(client).status_code == 403

    def test_protocol_recommendation(self):
        self._app_with_target()
        cases = [
            (
                (
                    200,
                    {"value": {"Enc": {"mainStream": {"width": 2560, "height": 1920}}}},
                ),
                "http-flv",
            ),
            ((200, [{"Enc": {"mainStream": {"width": 3840, "height": 2160}}}]), "rtsp"),
        ]
        with AuthTestClient(self.app) as client:
            for reply, protocol in cases:
                with patch.object(camera_api, "query_reolink", return_value=reply):
                    response = self._detect(client)
                assert response.json()["success"] is True
                assert response.json()["protocol"] == protocol

    def test_detection_failures(self):
        self._app_with_target()
        cases = [
            ({"return_value": (401, {})}, "HTTP 401"),
            ({"return_value": (200, {"value": {}})}, "Could not find stream"),
            (
                {"return_value": (200, {"Enc": {"mainStream": {"width": 0}}})},
                "Could not determine",
            ),
            ({"side_effect": CameraTimeoutError()}, "Connection timeout"),
            ({"side_effect": HTTPError()}, "Failed to connect to camera"),
            ({"side_effect": KeyError("Enc")}, "Unable to detect"),
        ]
        with AuthTestClient(self.app) as client:
            for kwargs, message in cases:
                with patch.object(camera_api, "query_reolink", **kwargs):
                    response = self._detect(client)
                assert response.json()["success"] is False
                assert message in response.json()["message"]


def _ptz_service(*, capabilities=None, presets=None, nodes=None, options=None):
    service = MagicMock()
    service.GetServiceCapabilities = AsyncMock(return_value=capabilities)
    service.GetPresets = AsyncMock(return_value=presets or [])
    service.GetNodes = AsyncMock(return_value=nodes or [])
    service.GetConfigurationOptions = AsyncMock(return_value=options)
    return service


def _onvif_camera(*, profiles=None, ptz=None, stream_uris=None, device_info=None):
    camera = MagicMock()
    device = MagicMock()
    device.GetDeviceInformation = AsyncMock(
        return_value=device_info
        or {"Manufacturer": "Acme", "Model": "PTZ-1", "FirmwareVersion": "1.2"}
    )
    camera.create_devicemgmt_service = AsyncMock(return_value=device)

    media = MagicMock()
    media.GetProfiles = AsyncMock(return_value=profiles or [])
    media.GetStreamUri = AsyncMock(side_effect=stream_uris or [])
    camera.create_media_service = AsyncMock(return_value=media)

    if ptz is None:
        camera.create_ptz_service = AsyncMock(side_effect=ONVIFError("no ptz"))
    else:
        camera.create_ptz_service = AsyncMock(return_value=ptz)

    camera.close = AsyncMock()
    return camera


class TestOnvifProbe(_CameraHttpTestCase):
    def _probe(self, camera, **params):
        query = {"host": "10.0.0.7", "port": 8000}
        query.update(params)
        with (
            patch.object(
                camera_api, "_connect_onvif_camera", AsyncMock(return_value=camera)
            ) as connect,
            AuthTestClient(self.app) as client,
        ):
            response = client.get("/onvif/probe", params=query)
        return response, connect

    def test_parameter_validation(self):
        with AuthTestClient(self.app) as client:
            assert client.get("/onvif/probe").status_code == 400
            assert client.get("/onvif/probe", params={"host": "a@b"}).status_code == 400
            assert (
                client.get(
                    "/onvif/probe", params={"host": "a", "auth_type": "ntlm"}
                ).status_code
                == 400
            )

    def test_full_ptz_camera_with_autotracking(self):
        profile = {"token": "main", "PTZConfiguration": {"token": "ptz-cfg"}}
        nodes = [{"SupportedPTZSpaces": {"ContinuousPanTiltVelocitySpace": [1]}}]
        options = {
            "Spaces": {
                "RelativePanTiltTranslationSpace": [
                    {"URI": "http://example/TranslationGenericSpace"},
                    SimpleNamespace(URI="http://example/TranslationSpaceFov"),
                ]
            }
        }
        ptz = _ptz_service(
            capabilities={"Capabilities": {"MoveStatus": "true"}},
            presets=[1, 2, 3],
            nodes=nodes,
            options=options,
        )
        camera = _onvif_camera(
            profiles=[profile, {"token": "sub"}, {}],
            ptz=ptz,
            stream_uris=[
                {"Uri": "rtsp://10.0.0.7/main"},
                {"Uri": "http://10.0.0.7/flv"},
            ],
        )

        response, connect = self._probe(
            camera, username="admin", password="pw", test=True
        )
        assert connect.call_args.args[5] == "basic"

        body = response.json()
        assert response.status_code == 200
        assert body["manufacturer"] == "Acme"
        assert body["profiles_count"] == 3
        assert body["ptz_supported"] is True
        assert body["pan_tilt_supported"] is True
        assert body["presets_count"] == 3
        assert body["autotrack_supported"] is True
        assert [c["uri"] for c in body["rtsp_candidates"]] == [
            "rtsp://admin:pw@10.0.0.7/main",
            "http://10.0.0.7/flv",
        ]
        assert len(body["rtsp_tested"]) == 2
        camera.close.assert_awaited_once()

    def test_probe_tests_credentialed_variant_of_plain_uri(self):
        camera = _onvif_camera(
            profiles=[{"token": "main"}],
            stream_uris=[{"Uri": "rtsp://10.0.0.7/main"}],
        )
        with patch.object(
            camera_api,
            "ffprobe_stream",
            side_effect=[_probe(0), RuntimeError("probe")],
        ):
            response, _ = self._probe(camera, test=True)

        body = response.json()
        assert body["ptz_supported"] is False
        assert body["rtsp_candidates"][0]["uri"] == "rtsp://10.0.0.7/main"
        assert [t["ok"] for t in body["rtsp_tested"]] == [True]

    def test_probe_falls_back_to_common_rtsp_patterns(self):
        camera = _onvif_camera(
            profiles=[{"token": "main"}],
            stream_uris=[RuntimeError("GetStreamUri")],
        )
        camera.create_devicemgmt_service = AsyncMock(side_effect=RuntimeError())
        response, _ = self._probe(camera, username="u", password="p")

        body = response.json()
        assert body["manufacturer"] == "Unknown"
        assert all(c["source"] == "pattern" for c in body["rtsp_candidates"])
        assert body["rtsp_candidates"][0]["uri"] == "rtsp://u:p@10.0.0.7:554/h264"
        assert "rtsp_tested" not in body

    def test_ptz_without_movestatus(self):
        ptz = _ptz_service(
            capabilities=SimpleNamespace(MoveStatus=False),
            options=SimpleNamespace(
                Spaces=SimpleNamespace(
                    RelativePanTiltTranslationSpace=[
                        SimpleNamespace(URI="TranslationSpaceFov")
                    ]
                )
            ),
        )
        ptz.GetPresets.side_effect = RuntimeError("no presets")
        ptz.GetNodes.side_effect = RuntimeError("no nodes")
        camera = _onvif_camera(
            profiles=[
                SimpleNamespace(
                    token="main", PTZConfiguration=SimpleNamespace(token="cfg")
                )
            ],
            ptz=ptz,
            stream_uris=[SimpleNamespace(Uri="rtsp://u:p@10.0.0.7/main")],
        )
        response, _ = self._probe(camera)

        body = response.json()
        assert body["ptz_supported"] is True
        assert body["presets_count"] == 0
        assert body["pan_tilt_supported"] is False
        assert body["autotrack_supported"] is False
        assert body["rtsp_candidates"][0]["uri"] == "rtsp://u:p@10.0.0.7/main"

    def test_ptz_service_capabilities_unavailable(self):
        ptz = _ptz_service()
        ptz.GetServiceCapabilities.side_effect = RuntimeError("unsupported")
        camera = _onvif_camera(profiles=[{"token": "main"}], ptz=ptz)
        response, _ = self._probe(camera)
        assert response.json()["ptz_supported"] is False

    def test_connection_errors(self):
        cases = [
            (ONVIFError("bad"), 400, "ONVIF error"),
            (Fault("auth"), 503, "Connection error"),
            (RuntimeError("boom"), 500, "Probe failed"),
        ]
        for error, status, message in cases:
            with (
                patch.object(
                    camera_api, "_connect_onvif_camera", AsyncMock(side_effect=error)
                ),
                AuthTestClient(self.app) as client,
            ):
                response = client.get("/onvif/probe", params={"host": "10.0.0.7"})
            assert response.status_code == status
            assert response.json()["message"] == message

    def test_supports_continuous_pan_tilt(self):
        assert camera_api._supports_continuous_pan_tilt(None) is False
        assert camera_api._supports_continuous_pan_tilt([{}]) is False
        assert (
            camera_api._supports_continuous_pan_tilt(
                [SimpleNamespace(SupportedPTZSpaces={"Other": 1})]
            )
            is False
        )


class TestConnectOnvifCamera(_CameraHttpTestCase):
    def test_falls_back_to_password_text(self):
        digest = MagicMock()
        digest.update_xaddrs = AsyncMock(side_effect=Fault("digest rejected"))
        text = MagicMock()
        text.update_xaddrs = AsyncMock()

        with (
            patch.object(camera_api, "ONVIFCamera", side_effect=[digest, text]) as cls,
            patch.object(camera_api, "_build_digest_transport") as transport,
        ):
            import asyncio

            result = asyncio.run(
                camera_api._connect_onvif_camera(
                    "10.0.0.7", 80, "u", "p", None, "digest"
                )
            )

        assert result is text
        assert [c.kwargs["encrypt"] for c in cls.call_args_list] == [True, False]
        assert text.devicemgmt.zeep_client.transport is transport.return_value

    def test_raises_first_fault_when_both_encodings_fail(self):
        first = Fault("first")
        cameras = []
        for error in (first, Fault("second")):
            cam = MagicMock()
            cam.update_xaddrs = AsyncMock(side_effect=error)
            cameras.append(cam)

        with patch.object(camera_api, "ONVIFCamera", side_effect=cameras):
            import asyncio

            with self.assertRaises(Fault) as raised:
                asyncio.run(
                    camera_api._connect_onvif_camera(
                        "10.0.0.7", 80, "", "", None, "basic"
                    )
                )
        assert raised.exception is first


class TestCameraSet(_CameraHttpTestCase):
    def setUp(self):
        super().setUp()
        self.dispatcher = MagicMock()
        self.dispatcher._camera_settings_handlers = {
            "detect": None,
            "zone": None,
            "motion_mask": None,
        }
        self.app.dispatcher = self.dispatcher

    def _topics(self) -> list[tuple]:
        return [c.args for c in self.dispatcher._receive.call_args_list]

    def test_profile_requires_wildcard(self):
        with AuthTestClient(self.app) as client:
            bad = client.put("/camera/front_door/set/profile", json={"value": "away"})
            ok = client.put("/camera/*/set/profile", json={"value": "away"})
        assert bad.status_code == 400
        assert ok.status_code == 200
        assert self._topics() == [("profile/set", "away")]

    def test_feature_validation(self):
        with AuthTestClient(self.app) as client:
            unknown = client.put("/camera/front_door/set/bogus", json={"value": "ON"})
            extra_sub = client.put(
                "/camera/front_door/set/detect/foo", json={"value": "ON"}
            )
            missing_sub = client.put(
                "/camera/front_door/set/zone", json={"value": "ON"}
            )
            missing_camera = client.put(
                "/camera/missing/set/detect", json={"value": "ON"}
            )
        assert unknown.status_code == 400
        assert extra_sub.status_code == 400
        assert missing_sub.status_code == 400
        assert missing_camera.status_code == 404
        assert self._topics() == []

    def test_routes_to_dispatcher_topics(self):
        with AuthTestClient(self.app) as client:
            client.put("/camera/front_door/set/detect", json={"value": "OFF"})
            client.put("/camera/front_door/set/zone/porch", json={"value": "ON"})
            client.put("/camera/*/set/detect", json={"value": "ON"})
        assert self._topics() == [
            ("front_door/detect/set", "OFF"),
            ("front_door/zone/porch/set", "ON"),
            ("front_door/detect/set", "ON"),
        ]
