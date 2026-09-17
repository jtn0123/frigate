import os
import shutil
import tempfile
from datetime import datetime
from typing import Any
from unittest.mock import Mock, patch

from fastapi import HTTPException
from playhouse.shortcuts import model_to_dict

from frigate.api.auth import get_allowed_cameras_for_filter, get_current_user
from frigate.comms.event_metadata_updater import EventMetadataPublisher
from frigate.models import Event, Recordings, ReviewSegment, Timeline
from frigate.stats.emitter import StatsEmitter
from frigate.test.http_api.base_http_test import AuthTestClient, BaseTestHttp, Request
from frigate.test.test_storage import _insert_mock_event


class TestHttpApp(BaseTestHttp):
    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment, Timeline])
        self.app = super().create_app()

        # Mock get_current_user for all tests
        async def mock_get_current_user(request: Request):
            username = request.headers.get("remote-user")
            role = request.headers.get("remote-role")
            if not username or not role:
                from fastapi.responses import JSONResponse

                return JSONResponse(
                    content={"message": "No authorization headers."}, status_code=401
                )
            return {"username": username, "role": role}

        self.app.dependency_overrides[get_current_user] = mock_get_current_user

        async def mock_get_allowed_cameras_for_filter(request: Request):
            return ["front_door"]

        self.app.dependency_overrides[get_allowed_cameras_for_filter] = (
            mock_get_allowed_cameras_for_filter
        )

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()

    ####################################################################################################################
    ###################################  GET /events Endpoint   #########################################################
    ####################################################################################################################
    def test_get_event_list_no_events(self):
        with AuthTestClient(self.app) as client:
            events = client.get("/events").json()
            assert len(events) == 0

    def test_get_event_list_no_match_event_id(self):
        id = "123456.random"
        with AuthTestClient(self.app) as client:
            super().insert_mock_event(id)
            events = client.get("/events", params={"event_id": "abc"}).json()
            assert len(events) == 0

    def test_get_event_list_match_event_id(self):
        id = "123456.random"
        with AuthTestClient(self.app) as client:
            super().insert_mock_event(id)
            events = client.get("/events", params={"event_id": id}).json()
            assert len(events) == 1
            assert events[0]["id"] == id

    def test_get_event_list_match_length(self):
        now = int(datetime.now().timestamp())

        id = "123456.random"
        with AuthTestClient(self.app) as client:
            super().insert_mock_event(id, now, now + 1)
            events = client.get(
                "/events", params={"max_length": 1, "min_length": 1}
            ).json()
            assert len(events) == 1
            assert events[0]["id"] == id

    def test_get_event_list_no_match_max_length(self):
        now = int(datetime.now().timestamp())

        with AuthTestClient(self.app) as client:
            id = "123456.random"
            super().insert_mock_event(id, now, now + 2)
            events = client.get("/events", params={"max_length": 1}).json()
            assert len(events) == 0

    def test_get_event_list_no_match_min_length(self):
        now = int(datetime.now().timestamp())

        with AuthTestClient(self.app) as client:
            id = "123456.random"
            super().insert_mock_event(id, now, now + 2)
            events = client.get("/events", params={"min_length": 3}).json()
            assert len(events) == 0

    def test_get_event_list_limit(self):
        now = datetime.now().timestamp()
        id = "123456.random"
        id2 = "54321.random"

        with AuthTestClient(self.app) as client:
            super().insert_mock_event(id, start_time=now + 1)
            events = client.get("/events").json()
            assert len(events) == 1
            assert events[0]["id"] == id

            super().insert_mock_event(id2, start_time=now)
            events = client.get("/events").json()
            assert len(events) == 2

            events = client.get("/events", params={"limit": 1}).json()
            assert len(events) == 1
            assert events[0]["id"] == id

            events = client.get("/events", params={"limit": 3}).json()
            assert len(events) == 2

    def test_get_event_list_no_match_has_clip(self):
        now = int(datetime.now().timestamp())

        with AuthTestClient(self.app) as client:
            id = "123456.random"
            super().insert_mock_event(id, now, now + 2)
            events = client.get("/events", params={"has_clip": 0}).json()
            assert len(events) == 0

    def test_get_event_list_has_clip(self):
        with AuthTestClient(self.app) as client:
            id = "123456.random"
            super().insert_mock_event(id, has_clip=True)
            events = client.get("/events", params={"has_clip": 1}).json()
            assert len(events) == 1
            assert events[0]["id"] == id

    def test_get_event_list_sort_score(self):
        with AuthTestClient(self.app) as client:
            id = "123456.random"
            id2 = "54321.random"
            super().insert_mock_event(id, top_score=37, score=37, data={"score": 50})
            super().insert_mock_event(id2, top_score=47, score=47, data={"score": 20})
            events = client.get("/events", params={"sort": "score_asc"}).json()
            assert len(events) == 2
            assert events[0]["id"] == id2
            assert events[1]["id"] == id

            events = client.get("/events", params={"sort": "score_desc"}).json()
            assert len(events) == 2
            assert events[0]["id"] == id
            assert events[1]["id"] == id2

    def test_get_event_list_sort_start_time(self):
        now = int(datetime.now().timestamp())

        with AuthTestClient(self.app) as client:
            id = "123456.random"
            id2 = "54321.random"
            super().insert_mock_event(id, start_time=now + 3)
            super().insert_mock_event(id2, start_time=now)
            events = client.get("/events", params={"sort": "date_asc"}).json()
            assert len(events) == 2
            assert events[0]["id"] == id2
            assert events[1]["id"] == id

            events = client.get("/events", params={"sort": "date_desc"}).json()
            assert len(events) == 2
            assert events[0]["id"] == id
            assert events[1]["id"] == id2

    def test_get_event_list_match_multilingual_attribute(self):
        event_id = "123456.zh"
        attribute = "中文标签"

        with AuthTestClient(self.app) as client:
            super().insert_mock_event(event_id, data={"custom_attr": attribute})

            events = client.get("/events", params={"attributes": attribute}).json()
            assert len(events) == 1
            assert events[0]["id"] == event_id

            events = client.get(
                "/events", params={"attributes": "%E4%B8%AD%E6%96%87%E6%A0%87%E7%AD%BE"}
            ).json()
            assert len(events) == 1
            assert events[0]["id"] == event_id

    def test_events_search_match_multilingual_attribute(self):
        event_id = "123456.zh.search"
        attribute = "中文标签"
        mock_embeddings = Mock()
        mock_embeddings.search_thumbnail.return_value = [(event_id, 0.05)]

        self.app.frigate_config.semantic_search.enabled = True
        self.app.embeddings = mock_embeddings

        with AuthTestClient(self.app) as client:
            super().insert_mock_event(event_id, data={"custom_attr": attribute})

            events = client.get(
                "/events/search",
                params={
                    "search_type": "similarity",
                    "event_id": event_id,
                    "attributes": attribute,
                },
            ).json()
            assert len(events) == 1
            assert events[0]["id"] == event_id

            events = client.get(
                "/events/search",
                params={
                    "search_type": "similarity",
                    "event_id": event_id,
                    "attributes": "%E4%B8%AD%E6%96%87%E6%A0%87%E7%AD%BE",
                },
            ).json()
            assert len(events) == 1
            assert events[0]["id"] == event_id

    def test_similarity_search_hides_unauthorized_anchor_event(self):
        mock_embeddings = Mock()
        self.app.frigate_config.semantic_search.enabled = True
        self.app.embeddings = mock_embeddings

        with AuthTestClient(self.app) as client:
            super().insert_mock_event("hidden.anchor", camera="back_door")
            response = client.get(
                "/events/search",
                params={
                    "search_type": "similarity",
                    "event_id": "hidden.anchor",
                },
            )

        assert response.status_code == 404
        assert response.json()["message"] == "Event not found"
        mock_embeddings.search_thumbnail.assert_not_called()

    def test_get_good_event(self):
        id = "123456.random"

        with AuthTestClient(self.app) as client:
            super().insert_mock_event(id)
            event = client.get(f"/events/{id}").json()

        assert event
        assert event["id"] == id
        assert event["id"] == model_to_dict(Event.get(Event.id == id))["id"]

    def test_get_bad_event(self):
        id = "123456.random"
        bad_id = "654321.other"

        with AuthTestClient(self.app) as client:
            super().insert_mock_event(id)
            event_response = client.get(f"/events/{bad_id}")
            assert event_response.status_code == 404
            assert event_response.json() == "Event not found"

    def test_delete_event(self):
        id = "123456.random"

        with AuthTestClient(self.app) as client:
            super().insert_mock_event(id)
            event = client.get(f"/events/{id}").json()
            assert event
            assert event["id"] == id
            response = client.delete(f"/events/{id}", headers={"remote-role": "admin"})
            assert response.status_code == 200
            event_after_delete = client.get(f"/events/{id}")
            assert event_after_delete.status_code == 404

    def test_event_retention(self):
        id = "123456.random"

        with AuthTestClient(self.app) as client:
            super().insert_mock_event(id)
            client.post(f"/events/{id}/retain", headers={"remote-role": "admin"})
            event = client.get(f"/events/{id}").json()
            assert event
            assert event["id"] == id
            assert event["retain_indefinitely"] is True
            client.delete(f"/events/{id}/retain", headers={"remote-role": "admin"})
            event = client.get(f"/events/{id}").json()
            assert event
            assert event["id"] == id
            assert event["retain_indefinitely"] is False

    def test_event_time_filtering(self):
        morning_id = "123456.random"
        evening_id = "654321.random"
        morning = 1656590400  # 06/30/2022 6 am (GMT)
        evening = 1656633600  # 06/30/2022 6 pm (GMT)

        with AuthTestClient(self.app) as client:
            super().insert_mock_event(morning_id, morning)
            super().insert_mock_event(evening_id, evening)
            # both events come back
            events = client.get("/events").json()
            assert events
            assert len(events) == 2
            # morning event is excluded
            events = client.get(
                "/events",
                params={"time_range": "07:00,24:00"},
            ).json()
            assert events
            assert len(events) == 1
            # evening event is excluded
            events = client.get(
                "/events",
                params={"time_range": "00:00,18:00"},
            ).json()
            assert events
            assert len(events) == 1

    def test_set_delete_sub_label(self):
        mock_event_updater = Mock(spec=EventMetadataPublisher)
        app = super().create_app(event_metadata_publisher=mock_event_updater)
        id = "123456.random"
        sub_label = "sub"

        def update_event(payload: Any, topic: str):
            event = Event.get(id=id)
            event.sub_label = payload[1]
            event.save()

        mock_event_updater.publish.side_effect = update_event

        with AuthTestClient(app) as client:
            super().insert_mock_event(id)
            new_sub_label_response = client.post(
                f"/events/{id}/sub_label",
                json={"subLabel": sub_label},
                headers={"remote-role": "admin"},
            )
            assert new_sub_label_response.status_code == 200
            event = client.get(f"/events/{id}").json()
            assert event
            assert event["id"] == id
            assert event["sub_label"] == sub_label
            empty_sub_label_response = client.post(
                f"/events/{id}/sub_label",
                json={"subLabel": ""},
                headers={"remote-role": "admin"},
            )
            assert empty_sub_label_response.status_code == 200
            event = client.get(f"/events/{id}").json()
            assert event
            assert event["id"] == id
            assert event["sub_label"] == None

    def test_sub_label_list(self):
        mock_event_updater = Mock(spec=EventMetadataPublisher)
        app = super().create_app(event_metadata_publisher=mock_event_updater)
        app.event_metadata_publisher = mock_event_updater
        id = "123456.random"
        sub_label = "sub"

        def update_event(payload: Any, _: str):
            event = Event.get(id=id)
            event.sub_label = payload[1]
            event.save()

        mock_event_updater.publish.side_effect = update_event

        with AuthTestClient(app) as client:
            super().insert_mock_event(id)
            client.post(
                f"/events/{id}/sub_label",
                json={"subLabel": sub_label},
                headers={"remote-role": "admin"},
            )
            sub_labels = client.get("/sub_labels").json()
            assert sub_labels
            assert sub_labels == [sub_label]

    ####################################################################################################################
    ###################################  GET /metrics Endpoint   #########################################################
    ####################################################################################################################
    def test_get_metrics(self):
        """ensure correct prometheus metrics api response"""
        with AuthTestClient(self.app) as client:
            ts_start = datetime.now().timestamp()
            ts_end = ts_start + 30
            _insert_mock_event(
                id="abcde.random", start=ts_start, end=ts_end, retain=True
            )
            _insert_mock_event(
                id="01234.random", start=ts_start, end=ts_end, retain=True
            )
            _insert_mock_event(
                id="56789.random", start=ts_start, end=ts_end, retain=True
            )
            _insert_mock_event(
                id="101112.random",
                label="outside",
                start=ts_start,
                end=ts_end,
                retain=True,
            )
            _insert_mock_event(
                id="131415.random",
                label="outside",
                start=ts_start,
                end=ts_end,
                retain=True,
            )
            _insert_mock_event(
                id="161718.random",
                camera="porch",
                start=ts_start,
                end=ts_end,
                retain=True,
            )
            _insert_mock_event(
                id="192021.random",
                camera="porch",
                start=ts_start,
                end=ts_end,
                retain=True,
            )
            _insert_mock_event(
                id="222324.random",
                camera="porch",
                label="inside",
                start=ts_start,
                end=ts_end,
                retain=True,
            )
            _insert_mock_event(
                id="252627.random",
                camera="porch",
                label="inside",
                start=ts_start,
                end=ts_end,
                retain=True,
            )
            _insert_mock_event(
                id="282930.random",
                label="inside",
                start=ts_start,
                end=ts_end,
                retain=True,
            )
            _insert_mock_event(
                id="313233.random",
                label="inside",
                start=ts_start,
                end=ts_end,
                retain=True,
            )

            stats_emitter = Mock(spec=StatsEmitter)
            stats_emitter.get_latest_stats.return_value = self.test_stats
            self.app.stats_emitter = stats_emitter
            event = client.get("/metrics")

        assert "# TYPE frigate_detection_total_fps gauge" in event.text
        assert "frigate_detection_total_fps 13.7" in event.text
        assert (
            "# HELP frigate_camera_events_retained Current retained camera events; decreases when events expire"
            in event.text
        )
        assert "# TYPE frigate_camera_events_retained gauge" in event.text
        assert (
            'frigate_camera_events_retained{camera="front_door",label="Mock"} 3.0'
            in event.text
        )
        assert (
            'frigate_camera_events_retained{camera="front_door",label="inside"} 2.0'
            in event.text
        )
        assert (
            'frigate_camera_events_retained{camera="front_door",label="outside"} 2.0'
            in event.text
        )
        assert (
            'frigate_camera_events_retained{camera="porch",label="Mock"} 2.0'
            in event.text
        )
        assert (
            'frigate_camera_events_retained{camera="porch",label="inside"} 2.0'
            in event.text
        )


class TestHttpEventSearch(BaseTestHttp):
    """Sort, limit, and review thumb lookup behaviour of GET /events/search."""

    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment, Timeline])
        self.app = super().create_app()
        self.app.frigate_config.semantic_search.enabled = True
        self.embeddings = Mock()
        self.app.embeddings = self.embeddings

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()

    def _insert_events(self):
        now = datetime.now().timestamp()
        # id, start offset, score, speed
        rows = [
            ("ev.a", -300, 0.9, 5.0),
            ("ev.b", -200, 0.5, None),
            ("ev.c", -100, 0.7, 1.0),
        ]
        for event_id, offset, score, speed in rows:
            data = {"score": score, "top_score": score}
            if speed is not None:
                data["average_estimated_speed"] = speed
            super().insert_mock_event(event_id, start_time=now + offset, data=data)
        # relevance order: c, a, b
        self.embeddings.search_thumbnail.return_value = [
            ("ev.c", 0.1),
            ("ev.a", 0.2),
            ("ev.b", 0.3),
        ]

    def _search(self, **params):
        params.setdefault("search_type", "similarity")
        params.setdefault("event_id", "ev.a")
        with AuthTestClient(self.app) as client:
            response = client.get("/events/search", params=params)
        assert response.status_code == 200, response.text
        return [e["id"] for e in response.json()]

    def test_relevance_sort_and_limit(self):
        self._insert_events()
        assert self._search() == ["ev.c", "ev.a", "ev.b"]
        assert self._search(sort="relevance", limit=2) == ["ev.c", "ev.a"]

    def test_score_sort_and_limit(self):
        self._insert_events()
        assert self._search(sort="score_desc") == ["ev.a", "ev.c", "ev.b"]
        assert self._search(sort="score_asc", limit=2) == ["ev.b", "ev.c"]

    def test_speed_sort_puts_missing_speed_last(self):
        self._insert_events()
        assert self._search(sort="speed_asc") == ["ev.c", "ev.a", "ev.b"]
        assert self._search(sort="speed_desc") == ["ev.a", "ev.c", "ev.b"]

    def test_date_sort(self):
        self._insert_events()
        assert self._search(sort="date_asc") == ["ev.a", "ev.b", "ev.c"]
        assert self._search(sort="date_desc", limit=1) == ["ev.c"]

    def test_limit_does_not_change_which_events_match(self):
        self._insert_events()
        # only events returned by the vector search are candidates
        self.embeddings.search_thumbnail.return_value = [("ev.b", 0.1)]
        assert self._search(sort="score_desc", limit=10) == ["ev.b"]

    def test_review_thumb_path_is_attached(self):
        self._insert_events()
        now = datetime.now().timestamp()
        super().insert_mock_review_segment(
            "rev.1",
            start_time=now - 320,
            end_time=now - 250,
            data={"detections": ["ev.a"]},
        )
        ReviewSegment.update(thumb_path="/thumbs/rev.1.webp").where(
            ReviewSegment.id == "rev.1"
        ).execute()

        with AuthTestClient(self.app) as client:
            events = client.get(
                "/events/search",
                params={"search_type": "similarity", "event_id": "ev.a"},
            ).json()

        by_id = {e["id"]: e for e in events}
        assert by_id["ev.a"]["thumb_path"] == "/thumbs/rev.1.webp"
        assert by_id["ev.b"]["thumb_path"] is None
        assert "thumbnail" in by_id["ev.a"]
        assert by_id["ev.a"]["search_source"] == "thumbnail"

        with AuthTestClient(self.app) as client:
            events = client.get(
                "/events/search",
                params={
                    "search_type": "similarity",
                    "event_id": "ev.a",
                    "include_thumbnails": 0,
                },
            ).json()
        assert all("thumbnail" not in e for e in events)

    def test_review_thumb_path_includes_a_review_in_progress(self):
        self._insert_events()
        now = datetime.now().timestamp()
        super().insert_mock_review_segment(
            "rev.live", start_time=now - 320, data={"detections": ["ev.a"]}
        )
        # an ongoing review segment has no end time yet
        ReviewSegment.update(end_time=None, thumb_path="/thumbs/rev.live.webp").where(
            ReviewSegment.id == "rev.live"
        ).execute()

        with AuthTestClient(self.app) as client:
            events = client.get(
                "/events/search",
                params={"search_type": "similarity", "event_id": "ev.a"},
            ).json()

        by_id = {e["id"]: e for e in events}
        assert by_id["ev.a"]["thumb_path"] == "/thumbs/rev.live.webp"


class TestHttpEventsBulkDelete(BaseTestHttp):
    """DELETE /events/ (G14): chunked fetch, one access check per camera."""

    def setUp(self):
        super().setUp([Event, Recordings, ReviewSegment, Timeline])
        self.minimal_config["cameras"]["back_door"] = self.minimal_config["cameras"][
            "front_door"
        ]
        self.app = super().create_app()
        self.clips_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.clips_dir, ignore_errors=True)
        clips_patch = patch("frigate.api.fork_bulk.CLIPS_DIR", self.clips_dir)
        clips_patch.start()
        self.addCleanup(clips_patch.stop)

    def tearDown(self):
        self.app.dependency_overrides.clear()
        super().tearDown()

    def _insert_events(self, count: int, prefix: str = "event") -> list[str]:
        """Insert events alternating between the cameras, with a timeline row each."""
        ids = [f"{prefix}_{index}" for index in range(count)]
        events = [
            {
                "id": event_id,
                "label": "person",
                "camera": "front_door" if index % 2 == 0 else "back_door",
                "start_time": 1000.0 + index,
                "end_time": 1020.0 + index,
                "top_score": 100,
                "score": 0,
                "false_positive": False,
                "zones": [],
                "thumbnail": "",
                "region": [],
                "box": [],
                "area": 0,
                "has_clip": True,
                "has_snapshot": True,
                "data": {},
            }
            for index, event_id in enumerate(ids)
        ]
        timeline = [
            {
                "timestamp": event["start_time"],
                "camera": event["camera"],
                "source": "tracked_object",
                "source_id": event["id"],
                "class_type": "visible",
                "data": {},
            }
            for event in events
        ]

        for start in range(0, count, 100):
            Event.insert_many(events[start : start + 100]).execute()
            Timeline.insert_many(timeline[start : start + 100]).execute()

        return ids

    def _delete(self, client: AuthTestClient, ids: list[str]):
        return client.request("DELETE", "/events/", json={"event_ids": ids})

    def _count_statements(self, client: AuthTestClient, ids: list[str]) -> int:
        """Number of SQL statements one bulk delete runs."""
        real_execute_sql = self.db.execute_sql
        statements: list[str] = []

        def counting_execute_sql(sql, *args, **kwargs):
            statements.append(sql)
            return real_execute_sql(sql, *args, **kwargs)

        with patch.object(self.db, "execute_sql", counting_execute_sql):
            response = self._delete(client, ids)

        assert response.status_code == 200
        assert response.json()["deleted_events"] == ids
        return len(statements)

    def test_no_ids(self):
        with AuthTestClient(self.app) as client:
            response = self._delete(client, [])

        assert response.status_code == 404
        assert response.json() == {
            "success": False,
            "message": "No event IDs provided.",
        }

    def test_more_than_a_thousand_ids(self):
        ids = self._insert_events(1200)
        kept = self._insert_events(3, prefix="kept")
        embeddings = Mock()
        self.app.embeddings = embeddings

        with AuthTestClient(self.app) as client:
            response = self._delete(client, ids)

        assert response.status_code == 200
        assert response.json() == {
            "success": True,
            "deleted_events": ids,
            "not_found_events": [],
        }
        assert [event.id for event in Event.select().order_by(Event.id)] == kept
        assert Timeline.select().count() == len(kept)

        # embeddings go in the same chunks of at most 500 ids
        for delete in (
            embeddings.db.delete_embeddings_thumbnail,
            embeddings.db.delete_embeddings_description,
        ):
            chunks = [call.kwargs["event_ids"] for call in delete.call_args_list]
            assert [len(chunk) for chunk in chunks] == [500, 500, 200]
            assert [event_id for chunk in chunks for event_id in chunk] == ids

    def test_mixed_found_missing_and_repeated_ids(self):
        ids = self._insert_events(3)
        requested = [ids[0], "missing_1", ids[2], ids[0], "missing_2"]

        with AuthTestClient(self.app) as client:
            response = self._delete(client, requested)

        # what deleting the ids one at a time reported: a repeated id is
        # deleted the first time and not found the second time
        assert response.status_code == 200
        assert response.json() == {
            "success": True,
            "deleted_events": [ids[0], ids[2]],
            "not_found_events": ["missing_1", ids[0], "missing_2"],
        }
        assert [event.id for event in Event.select()] == [ids[1]]
        assert [row.source_id for row in Timeline.select(Timeline.source_id)] == [
            ids[1]
        ]

    def test_snapshot_files_are_removed(self):
        ids = self._insert_events(2)
        files = [
            os.path.join(self.clips_dir, f"front_door-{ids[0]}{suffix}")
            for suffix in (".jpg", "-clean.png", "-clean.webp")
        ]
        other = os.path.join(self.clips_dir, "front_door-another_event.jpg")

        for file in [*files, other]:
            with open(file, "w") as f:
                f.write("x")

        with AuthTestClient(self.app) as client:
            # the second event has no files on disk, which is not an error
            response = self._delete(client, ids)

        assert response.status_code == 200
        assert os.listdir(self.clips_dir) == ["front_door-another_event.jpg"]

    def test_forbidden_camera_rejects_the_request(self):
        ids = self._insert_events(40)
        checked: list[str] = []

        async def deny_back_door(camera_name, request=None):
            checked.append(camera_name)
            if camera_name == "back_door":
                raise HTTPException(
                    status_code=403, detail="Access denied to camera 'back_door'."
                )

        with (
            patch("frigate.api.event.require_camera_access", deny_back_door),
            AuthTestClient(self.app) as client,
        ):
            response = self._delete(client, [*ids, "missing"])

        assert response.status_code == 403
        assert response.json()["detail"] == "Access denied to camera 'back_door'."
        # one check per distinct camera, in request order, and nothing deleted
        assert checked == ["front_door", "back_door"]
        assert Event.select().count() == 40
        assert Timeline.select().count() == 40

    def test_access_is_checked_once_per_camera(self):
        ids = self._insert_events(40)
        checked: list[str] = []

        async def allow(camera_name, request=None):
            checked.append(camera_name)

        with (
            patch("frigate.api.event.require_camera_access", allow),
            AuthTestClient(self.app) as client,
        ):
            response = self._delete(client, ids)

        assert response.status_code == 200
        assert checked == ["front_door", "back_door"]
        assert Event.select().count() == 0

    def test_statement_count_follows_chunks_not_events(self):
        with AuthTestClient(self.app) as client:
            few = self._count_statements(client, self._insert_events(10, "few"))
            many = self._count_statements(client, self._insert_events(400, "many"))
            chunks = self._count_statements(client, self._insert_events(1200, "big"))

        # one SELECT and two DELETEs per chunk of 500 ids
        assert (few, many, chunks) == (3, 3, 9), (few, many, chunks)

    def test_single_event_route(self):
        ids = self._insert_events(2)

        with AuthTestClient(self.app) as client:
            deleted = client.delete(f"/events/{ids[0]}")
            missing = client.delete("/events/missing")

        assert deleted.status_code == 200
        assert deleted.json() == {
            "success": True,
            "message": f"Event {ids[0]} deleted",
        }
        assert missing.status_code == 404
        assert missing.json() == {
            "success": False,
            "message": "Event missing not found",
        }
        assert [event.id for event in Event.select()] == [ids[1]]
        assert [row.source_id for row in Timeline.select(Timeline.source_id)] == [
            ids[1]
        ]
