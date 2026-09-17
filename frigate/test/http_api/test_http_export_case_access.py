"""Camera access on GET /cases and GET /cases/{case_id}."""

from fastapi import Request

from frigate.api.auth import get_allowed_cameras_for_filter
from frigate.models import Export, ExportCase
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp

_LIMITED = {"remote-user": "limited", "remote-role": "limited_user"}


class TestExportCaseCameraAccess(BaseTestHttp):
    def setUp(self):
        super().setUp([Export, ExportCase])
        self.minimal_config["cameras"]["backyard"] = {
            "ffmpeg": {
                "inputs": [{"path": "rtsp://10.0.0.2:554/video", "roles": ["detect"]}]
            },
            "detect": {"height": 1080, "width": 1920, "fps": 5},
        }
        self.app = super().create_app()

        for case_id, camera in (
            ("front_case", "front_door"),
            ("backyard_case", "backyard"),
            ("empty_case", None),
        ):
            case = ExportCase.create(
                id=case_id,
                name=f"{case_id} name",
                description="private notes",
                created_at=10,
                updated_at=10,
            )
            if camera is not None:
                Export.create(
                    id=f"{case_id}_export",
                    camera=camera,
                    name="clip",
                    date=100,
                    video_path=f"/tmp/{case_id}.mp4",
                    thumb_path=f"/tmp/{case_id}.webp",
                    in_progress=False,
                    export_case=case,
                )

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()

    def _restrict_to_front_door(self):
        async def front_door_only(request: Request):
            return ["front_door"]

        self.app.dependency_overrides[get_allowed_cameras_for_filter] = front_door_only

    def test_full_access_lists_every_case(self):
        with AuthTestClient(self.app) as client:
            resp = client.get("/cases")

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(
            {case["id"] for case in resp.json()},
            {"front_case", "backyard_case", "empty_case"},
        )

    def test_restricted_role_lists_only_cases_with_its_exports(self):
        self._restrict_to_front_door()

        with AuthTestClient(self.app) as client:
            resp = client.get("/cases", headers=_LIMITED)

        self.assertEqual(resp.status_code, 200)
        self.assertEqual([case["id"] for case in resp.json()], ["front_case"])

    def test_restricted_role_gets_404_for_other_cases(self):
        self._restrict_to_front_door()

        with AuthTestClient(self.app) as client:
            allowed = client.get("/cases/front_case", headers=_LIMITED)
            other = client.get("/cases/backyard_case", headers=_LIMITED)
            empty = client.get("/cases/empty_case", headers=_LIMITED)

        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(other.status_code, 404)
        self.assertEqual(empty.status_code, 404)

    def test_full_access_reads_an_empty_case(self):
        with AuthTestClient(self.app) as client:
            resp = client.get("/cases/empty_case")

        self.assertEqual(resp.status_code, 200)
