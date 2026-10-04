"""HTTP coverage for line zone crossing counts (D75)."""

from frigate.api.auth import get_allowed_cameras_for_filter
from frigate.models import Event, Recordings, ReviewSegment
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp

VIEWER = {"remote-user": "viewer", "remote-role": "viewer"}


def camera(zones: dict) -> dict:
    return {
        "ffmpeg": {
            "inputs": [{"path": "rtsp://10.0.0.1:554/video", "roles": ["detect"]}]
        },
        "detect": {"height": 1080, "width": 1920, "fps": 5},
        "zones": zones,
    }


class TestHttpForkLineCrossings(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment])
        self.minimal_config["cameras"] = {
            "front_door": camera(
                {
                    "walkway_in": {
                        "type": "line",
                        "coordinates": "0.2,0.6,0.8,0.6",
                        "direction": "a_to_b",
                    },
                    "walkway_out": {
                        "type": "line",
                        "coordinates": "0.2,0.6,0.8,0.6",
                        "direction": "b_to_a",
                    },
                    "porch": {"coordinates": "0,0,1,0,1,1"},
                }
            ),
            "driveway": camera(
                {"gate": {"type": "line", "coordinates": "0.1,0.1,0.9,0.1"}}
            ),
        }
        self.app = self.create_app()

    def event(self, id: str, camera: str, label: str, zones: list, start: float):
        Event.insert(
            id=id,
            label=label,
            camera=camera,
            start_time=start,
            end_time=start + 10,
            top_score=0.9,
            score=0.9,
            false_positive=False,
            zones=zones,
            thumbnail="",
            region=[],
            box=[],
            area=0,
            has_clip=True,
            has_snapshot=True,
            data={},
        ).execute()

    def seed(self):
        self.event("1", "front_door", "person", ["walkway_in", "porch"], 1000)
        self.event("2", "front_door", "person", ["walkway_in"], 1100)
        self.event("3", "front_door", "dog", ["walkway_in"], 1200)
        self.event("4", "front_door", "person", ["walkway_out"], 1300)
        self.event("5", "front_door", "person", ["porch"], 1400)
        self.event("6", "driveway", "car", ["gate"], 1500)
        # outside the window
        self.event("7", "front_door", "person", ["walkway_in"], 5000)
        # a zone named like a line on another camera does not count
        self.event("8", "driveway", "person", ["walkway_in"], 1600)

    def get(self, query: str, headers=None):
        with AuthTestClient(self.app) as client:
            response = client.get(f"/fork/line_crossings{query}", headers=headers)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_counts_per_line_and_label(self):
        self.seed()
        body = self.get("?after=0&before=2000")
        self.assertEqual(body["after"], 0)
        self.assertEqual(body["before"], 2000)
        lines = {(line["camera"], line["zone"]): line for line in body["lines"]}
        self.assertEqual(
            set(lines),
            {
                ("front_door", "walkway_in"),
                ("front_door", "walkway_out"),
                ("driveway", "gate"),
            },
        )
        walkway_in = lines[("front_door", "walkway_in")]
        self.assertEqual(walkway_in["total"], 3)
        self.assertEqual(walkway_in["labels"], {"person": 2, "dog": 1})
        self.assertEqual(walkway_in["direction"], "a_to_b")
        self.assertEqual(lines[("front_door", "walkway_out")]["total"], 1)
        self.assertEqual(lines[("driveway", "gate")]["labels"], {"car": 1})
        self.assertEqual(lines[("driveway", "gate")]["direction"], "both")

    def test_camera_and_zone_filters(self):
        self.seed()
        body = self.get("?camera=front_door&zone=walkway_out&after=0&before=2000")
        self.assertEqual(
            body["lines"],
            [
                {
                    "camera": "front_door",
                    "zone": "walkway_out",
                    "direction": "b_to_a",
                    "total": 1,
                    "labels": {"person": 1},
                }
            ],
        )

    def test_lines_without_crossings_report_zero(self):
        body = self.get("?camera=driveway&after=0&before=2000")
        self.assertEqual(body["lines"][0]["total"], 0)
        self.assertEqual(body["lines"][0]["labels"], {})

    def test_default_window_is_the_last_day(self):
        body = self.get("?before=100000")
        self.assertEqual(body["after"], 100000 - 24 * 3600)

    def test_viewer_only_sees_allowed_cameras(self):
        self.seed()
        self.app.dependency_overrides[get_allowed_cameras_for_filter] = lambda: [
            "driveway"
        ]
        body = self.get("?after=0&before=2000", headers=VIEWER)
        self.assertEqual([line["camera"] for line in body["lines"]], ["driveway"])

    def test_camera_without_lines_returns_nothing(self):
        self.minimal_config["cameras"]["front_door"]["zones"] = {}
        self.minimal_config["cameras"]["driveway"]["zones"] = {}
        self.app = self.create_app()
        self.assertEqual(self.get("")["lines"], [])
