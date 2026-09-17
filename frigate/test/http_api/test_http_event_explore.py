"""Tests for GET /events/explore: content, ordering, access and query count."""

from typing import Any
from unittest.mock import patch

from frigate.api.auth import get_allowed_cameras_for_filter
from frigate.models import Event, Recordings, ReviewSegment, Timeline
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp, Request

_CAMERAS = ["front_door", "back_door", "garage"]

_EXPLORE_DATA_KEYS = [
    "type",
    "score",
    "top_score",
    "description",
    "sub_label_score",
    "average_estimated_speed",
    "velocity_angle",
    "path_data",
    "recognized_license_plate",
    "recognized_license_plate_score",
]


def _camera_config(index: int) -> dict[str, Any]:
    return {
        "ffmpeg": {
            "inputs": [
                {"path": f"rtsp://10.0.0.{index + 1}:554/video", "roles": ["detect"]}
            ]
        },
        "detect": {"height": 1080, "width": 1920, "fps": 5},
    }


class TestHttpEventsExplore(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment, Timeline])
        self.minimal_config["auth"] = {"roles": {"limited_user": ["front_door"]}}
        self.minimal_config["cameras"] = {
            name: _camera_config(index) for index, name in enumerate(_CAMERAS)
        }
        self.app = super().create_app()
        # use the real dependency, so the role in the request headers decides
        del self.app.dependency_overrides[get_allowed_cameras_for_filter]
        self.rows: list[dict[str, Any]] = []

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()

    def _insert_events(self, labels: dict[str, int]) -> None:
        """Insert `count` events per label, spread over the cameras.

        Start times are unique and interleaved between labels, so the expected
        order is fully determined.
        """
        rows = []
        serial = len(self.rows)

        for index in range(max(labels.values())):
            for label, count in labels.items():
                if index >= count:
                    continue

                serial += 1
                rows.append(
                    {
                        "id": f"{1000 + serial}.{label}",
                        "label": label,
                        "camera": _CAMERAS[serial % len(_CAMERAS)],
                        "start_time": 1000.0 + serial,
                        "end_time": 1020.0 + serial,
                        "top_score": 0.5,
                        "score": 0.4,
                        "false_positive": False,
                        "zones": ["yard"] if serial % 2 else [],
                        "thumbnail": "not-in-the-response",
                        "region": [0, 0, 1, 1],
                        "box": [0.1, 0.2, 0.3, 0.4],
                        "area": 10,
                        "has_clip": bool(serial % 2),
                        "has_snapshot": True,
                        "sub_label": "bob" if serial % 3 == 0 else None,
                        "data": {
                            "type": "object",
                            "score": 0.4,
                            "top_score": 0.5,
                            "description": f"event {serial}",
                            "not_in_the_response": serial,
                        },
                    }
                )

        Event.insert_many(rows).execute()
        self.rows.extend(rows)

    def _expected(self, cameras: list[str], limit: int) -> list[dict[str, Any]]:
        """The documented response: per label the newest `limit` events, all
        sorted by the label's total count and then start time, descending."""
        visible = [row for row in self.rows if row["camera"] in cameras]
        expected = []

        for label in sorted({row["label"] for row in visible}):
            of_label = sorted(
                (row for row in visible if row["label"] == label),
                key=lambda row: row["start_time"],
                reverse=True,
            )
            for row in of_label[:limit]:
                expected.append(
                    {
                        "id": row["id"],
                        "camera": row["camera"],
                        "label": row["label"],
                        "zones": row["zones"],
                        "start_time": row["start_time"],
                        "end_time": row["end_time"],
                        "has_clip": row["has_clip"],
                        "has_snapshot": row["has_snapshot"],
                        "plus_id": None,
                        "retain_indefinitely": False,
                        "sub_label": row["sub_label"],
                        "top_score": row["top_score"],
                        "false_positive": row["false_positive"],
                        "box": row["box"],
                        "data": {
                            key: value
                            for key, value in row["data"].items()
                            if key in _EXPLORE_DATA_KEYS
                        },
                        "event_count": len(of_label),
                    }
                )

        return sorted(
            expected,
            key=lambda event: (event["event_count"], event["start_time"]),
            reverse=True,
        )

    def _count_selects(self, client: AuthTestClient, params: dict[str, Any]) -> int:
        """Number of SELECT statements one explore request runs."""
        real_execute_sql = self.db.execute_sql
        statements: list[str] = []

        def counting_execute_sql(sql, *args, **kwargs):
            statements.append(sql)
            return real_execute_sql(sql, *args, **kwargs)

        with patch.object(self.db, "execute_sql", counting_execute_sql):
            response = client.get("/events/explore", params=params)

        assert response.status_code == 200
        return len([sql for sql in statements if sql.lstrip().startswith("SELECT")])

    def test_no_events(self):
        with AuthTestClient(self.app) as client:
            response = client.get("/events/explore")
            assert response.status_code == 200
            assert response.json() == []

    def test_content_and_order(self):
        self._insert_events({"person": 7, "car": 4, "dog": 4, "cat": 1})

        with AuthTestClient(self.app) as client:
            response = client.get("/events/explore", params={"limit": 3})
            assert response.status_code == 200
            events = response.json()

        assert events == self._expected(_CAMERAS, 3)
        # 3 each of person, car and dog, and the one cat
        assert len(events) == 10
        assert [event["label"] for event in events[:3]] == ["person"] * 3
        assert events[-1]["label"] == "cat"
        assert all("thumbnail" not in event for event in events)

    def test_default_limit_is_ten(self):
        self._insert_events({"person": 14, "car": 2})

        with AuthTestClient(self.app) as client:
            events = client.get("/events/explore").json()

        assert events == self._expected(_CAMERAS, 10)
        assert len(events) == 12

    def test_zero_and_negative_limit_follow_sql_limit(self):
        self._insert_events({"person": 3, "car": 2})

        with AuthTestClient(self.app) as client:
            none = client.get("/events/explore", params={"limit": 0}).json()
            everything = client.get("/events/explore", params={"limit": -1}).json()

        assert none == []
        assert everything == self._expected(_CAMERAS, 5)

    def test_restricted_role_sees_only_its_cameras(self):
        self._insert_events({"person": 9, "car": 6, "dog": 1})

        with AuthTestClient(self.app) as client:
            response = client.get(
                "/events/explore",
                params={"limit": 2},
                headers={"remote-user": "guest", "remote-role": "limited_user"},
            )
            assert response.status_code == 200
            events = response.json()

        assert events
        assert {event["camera"] for event in events} == {"front_door"}
        # the counts cover the allowed cameras only
        assert events == self._expected(["front_door"], 2)
        assert events[0]["event_count"] == 3

    def test_mocked_camera_filter_is_applied(self):
        self._insert_events({"person": 6, "car": 3})

        async def only_garage(request: Request):
            return ["garage"]

        self.app.dependency_overrides[get_allowed_cameras_for_filter] = only_garage

        with AuthTestClient(self.app) as client:
            events = client.get("/events/explore").json()

        assert events == self._expected(["garage"], 10)

    def test_no_allowed_cameras_returns_nothing(self):
        self._insert_events({"person": 2})

        async def no_cameras(request: Request):
            return []

        self.app.dependency_overrides[get_allowed_cameras_for_filter] = no_cameras

        with AuthTestClient(self.app) as client:
            assert client.get("/events/explore").json() == []

    def test_query_count_does_not_grow_with_labels(self):
        with AuthTestClient(self.app) as client:
            self._insert_events({"person": 3, "car": 3})
            two_labels = self._count_selects(client, {"limit": 2})

            self._insert_events({f"label_{index}": 2 for index in range(20)})
            many_labels = self._count_selects(client, {"limit": 2})
            events = client.get("/events/explore", params={"limit": 2}).json()

        assert len({event["label"] for event in events}) == 22
        assert two_labels == many_labels, (two_labels, many_labels)
        assert many_labels == 1
