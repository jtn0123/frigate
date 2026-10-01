"""Tests for the go2rtc source state reducers and reader (fork I57)."""

import threading
import unittest
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock, patch

from requests.exceptions import ConnectTimeout

from frigate.fork.go2rtc_state import (
    GO2RTC_STREAMS_URL,
    MAX_CODECS,
    Go2rtcStateReader,
    RateTracker,
    camera_states,
    camera_stream_names,
    configured_sources,
    fetch_streams,
    media_codecs,
    missing_stream,
    reduce_stream,
    restream_name,
    safe_source,
)

SECRETS = ("admin", "hunter2", "s3cret", "tok123", "stream1", "channel")


def connected_producer(url: str, received: int = 1000) -> dict[str, Any]:
    return {
        "id": 1,
        "format_name": "rtsp",
        "remote_addr": "10.0.0.5:554",
        "url": url,
        "medias": [
            "video, recvonly, H264 High 4.1",
            "audio, recvonly, PCMA/8000, PCMU/8000",
        ],
        "bytes_recv": received,
    }


def config(
    cameras: dict[str, dict[str, Any]], streams: dict[str, Any] | None = None
) -> SimpleNamespace:
    return SimpleNamespace(
        go2rtc=SimpleNamespace(model_dump=lambda: {"streams": streams}),
        cameras={
            name: SimpleNamespace(
                live=SimpleNamespace(streams=spec.get("live", {name: name})),
                ffmpeg=SimpleNamespace(
                    inputs=[SimpleNamespace(path=p) for p in spec.get("inputs", [])]
                ),
            )
            for name, spec in cameras.items()
        },
    )


class TestSafeSource(unittest.TestCase):
    def assert_safe(self, raw: object, expected: str) -> None:
        reduced = safe_source(raw)
        self.assertEqual(reduced, expected)
        for secret in SECRETS:
            self.assertNotIn(secret, reduced)
        for character in "@?#&= ":
            self.assertNotIn(character, reduced)

    def test_userinfo_path_and_query_are_removed(self):
        self.assert_safe(
            "rtsp://admin:hunter2@10.0.0.5:554/stream1?channel=1",
            "rtsp://10.0.0.5:554",
        )

    def test_user_and_password_query_parameters_are_removed(self):
        self.assert_safe(
            "http://10.0.0.5/flv?port=1935&app=bcs&stream=channel0_main.bcs"
            "&user=admin&password=hunter2",
            "http://10.0.0.5",
        )

    def test_token_query_parameter_is_removed(self):
        self.assert_safe(
            "https://cam.example.com:8443/live?token=tok123",
            "https://cam.example.com:8443",
        )

    def test_ffmpeg_prefix_with_options_suffix(self):
        self.assert_safe(
            "ffmpeg:http://admin:hunter2@10.0.0.5/stream1?token=tok123#video=copy#audio=aac",
            "ffmpeg:http://10.0.0.5",
        )

    def test_exec_never_shows_its_command_line(self):
        self.assert_safe(
            "exec:ffmpeg -i rtsp://admin:hunter2@10.0.0.5/stream1 -f rtsp {output}",
            "exec",
        )
        self.assert_safe("echo:rtsp://admin:hunter2@10.0.0.5/stream1", "echo")
        self.assert_safe("expr:let s3cret = 1", "expr")

    def test_empty_and_non_string_are_unknown(self):
        self.assert_safe("", "unknown")
        self.assert_safe("   ", "unknown")
        self.assert_safe(None, "unknown")
        self.assert_safe(42, "unknown")

    def test_text_without_a_scheme_is_unknown(self):
        self.assert_safe("front_door", "unknown")
        self.assert_safe("10.0.0.5:554/stream1", "unknown")
        self.assert_safe("/media/stream1.mp4", "unknown")

    def test_credentials_without_a_scheme_are_not_taken_for_one(self):
        self.assert_safe("admin:hunter2@10.0.0.5/stream1", "unknown")
        self.assert_safe("ffmpeg:admin:hunter2@10.0.0.5", "ffmpeg")

    def test_unescaped_delimiter_in_password_keeps_only_the_scheme(self):
        # "admin:12" would otherwise pass for a host and port.
        self.assert_safe("rtsp://admin:12/34@10.0.0.5/stream1", "rtsp")
        self.assert_safe("rtsp://admin:s3c?ret@10.0.0.5/stream1", "rtsp")
        self.assert_safe("rtsp://admin:s3c#ret@10.0.0.5/stream1", "rtsp")

    def test_at_sign_inside_the_password(self):
        self.assert_safe(
            "rtsp://admin:hun@ter2@10.0.0.5:554/stream1", "rtsp://10.0.0.5:554"
        )

    def test_host_that_cannot_be_trusted_keeps_only_the_scheme(self):
        self.assert_safe("rtsp://{FRIGATE_HOST}/stream1", "rtsp")
        self.assert_safe("rtsp://10.0.0.5:99999/stream1", "rtsp")
        self.assert_safe("rtsp://10.0.0.5:0/stream1", "rtsp")
        self.assert_safe("rtsp://10.0.0.5:port/stream1", "rtsp")
        self.assert_safe("file:///media/stream1.mp4", "file")
        self.assert_safe("rtsp://", "rtsp")

    def test_scheme_and_host_are_lowercased(self):
        self.assert_safe("RTSP://Admin:hunter2@Cam.Local/stream1", "rtsp://cam.local")

    def test_ipv6_host(self):
        self.assertEqual(
            safe_source("rtsp://admin:hunter2@[fe80::1]:554/stream1"),
            "rtsp://[fe80::1]:554",
        )

    def test_prefixes_do_not_nest_without_bound(self):
        self.assert_safe(
            "ffmpeg:ffmpeg:rtsp://admin:hunter2@10.0.0.5/stream1", "ffmpeg"
        )
        self.assert_safe("ffmpeg:exec:cat /run/secrets/s3cret", "ffmpeg")
        self.assert_safe("ffmpeg:/media/stream1.mp4#video=h264", "ffmpeg")
        self.assert_safe(
            "webrtc:ws://10.0.0.5:8080/ws?token=tok123#format=kinesis",
            "webrtc:ws://10.0.0.5:8080",
        )

    def test_surrounding_whitespace_is_ignored(self):
        self.assert_safe("  rtsp://admin:hunter2@10.0.0.5/stream1\n", "rtsp://10.0.0.5")

    def test_overlong_scheme_is_unknown(self):
        self.assert_safe("a" * 40 + "://10.0.0.5", "unknown")


class TestCameraStreamNames(unittest.TestCase):
    def test_restream_name_reads_only_the_local_restream(self):
        self.assertEqual(
            restream_name("rtsp://127.0.0.1:8554/front_door"), "front_door"
        )
        self.assertEqual(
            restream_name(" rtsp://localhost:8554/front%20door?video&audio"),
            "front door",
        )
        self.assertIsNone(restream_name("rtsp://10.0.0.5:554/front_door"))
        self.assertIsNone(restream_name("rtsp://127.0.0.1:554/front_door"))
        self.assertIsNone(restream_name("rtsp://127.0.0.1:8554/"))

    def test_live_streams_inputs_and_own_name_without_duplicates(self):
        names = camera_stream_names(
            config(
                {
                    "front_door": {
                        "live": {"Main": "front_door_main", "Sub": "front_door_sub"},
                        "inputs": [
                            "rtsp://127.0.0.1:8554/front_door_sub",
                            "rtsp://127.0.0.1:8554/front_door_record",
                        ],
                    },
                    "garage": {"inputs": ["rtsp://10.0.0.9:554/h264"]},
                    "yard": {"live": {"Other": "yard_hd"}},
                },
                {"yard": "rtsp://10.0.0.7/1", "yard_hd": "rtsp://10.0.0.7/0"},
            )
        )
        self.assertEqual(
            names,
            {
                "front_door": [
                    "front_door_main",
                    "front_door_sub",
                    "front_door_record",
                ],
                "garage": ["garage"],
                "yard": ["yard_hd", "yard"],
            },
        )

    def test_camera_without_live_streams(self):
        self.assertEqual(
            camera_stream_names(config({"garage": {"live": {}}})), {"garage": []}
        )

    def test_configured_sources_accepts_strings_and_lists(self):
        sources = configured_sources(
            config(
                {}, {"a": "rtsp://10.0.0.1/1", "b": ["rtsp://10.0.0.2/1", 7], "c": None}
            )
        )
        self.assertEqual(
            sources,
            {"a": ["rtsp://10.0.0.1/1"], "b": ["rtsp://10.0.0.2/1"], "c": []},
        )

    def test_configured_sources_without_streams(self):
        self.assertEqual(configured_sources(config({}, None)), {})
        self.assertEqual(configured_sources(config({}, ["not", "a", "mapping"])), {})


class TestReduceStream(unittest.TestCase):
    def test_connected_stream(self):
        state = reduce_stream(
            "front_door",
            {
                "producers": [
                    connected_producer("rtsp://admin:hunter2@10.0.0.5:554/stream1")
                ],
                "consumers": [{"id": 2}, {"id": 3}],
            },
        )
        self.assertEqual(
            state,
            {
                "name": "front_door",
                "configured": True,
                "connected": True,
                "bytes_received": 1000,
                "bytes_per_second": None,
                "producers": 1,
                "consumers": 2,
                "codecs": ["H264", "PCMA", "PCMU"],
                "source": "rtsp://10.0.0.5:554",
            },
        )

    def test_idle_producer_has_only_its_url(self):
        state = reduce_stream(
            "doorbell",
            {
                "producers": [{"url": "rtsp://admin:hunter2@10.0.0.6/stream1"}],
                "consumers": None,
            },
        )
        self.assertFalse(state["connected"])
        self.assertTrue(state["configured"])
        self.assertEqual(state["bytes_received"], 0)
        self.assertEqual(state["consumers"], 0)
        self.assertEqual(state["codecs"], [])
        self.assertEqual(state["source"], "rtsp://10.0.0.6")

    def test_old_go2rtc_counter_and_bytes_without_medias(self):
        state = reduce_stream(
            "cam", {"producers": [{"url": "rtsp://10.0.0.5/1", "recv": 77}]}
        )
        self.assertTrue(state["connected"])
        self.assertEqual(state["bytes_received"], 77)

    def test_bytes_are_summed_and_source_prefers_the_connected_producer(self):
        state = reduce_stream(
            "cam",
            {
                "producers": [
                    {"url": "rtsp://10.0.0.5/1"},
                    connected_producer("ffmpeg:rtsp://10.0.0.8/1#audio=aac", 500),
                    connected_producer("rtsp://10.0.0.9/1", 250),
                ]
            },
        )
        self.assertEqual(state["bytes_received"], 750)
        self.assertEqual(state["producers"], 3)
        self.assertEqual(state["source"], "ffmpeg:rtsp://10.0.0.8")

    def test_malformed_entries_do_not_raise(self):
        for data in (None, [], "text", {"producers": "x", "consumers": 3}):
            state = reduce_stream("cam", data)
            self.assertFalse(state["connected"])
            self.assertEqual(state["producers"], 0)
            self.assertIsNone(state["source"])

        state = reduce_stream(
            "cam",
            {
                "producers": [
                    "text",
                    {"bytes_recv": True},
                    {"bytes_recv": "9"},
                    {"bytes_recv": -5},
                    {"bytes_recv": None, "recv": 3},
                ]
            },
        )
        self.assertEqual(state["producers"], 4)
        self.assertEqual(state["bytes_received"], 0)
        self.assertFalse(state["connected"])
        self.assertIsNone(state["source"])

    def test_codecs_skip_bad_medias_and_are_bounded(self):
        codecs = media_codecs(
            [
                {"medias": "video"},
                {"medias": [None, "video, recvonly", "video, recvonly, , ???"]},
                {
                    "medias": [
                        "video, recvonly, H265",
                        "audio, recvonly, MPEG4-GENERIC/16000, H265",
                        "audio, sendonly, "
                        + ", ".join(f"C{index}/8000" for index in range(10)),
                    ]
                },
            ]
        )
        self.assertEqual(codecs[:2], ["H265", "MPEG4-GENERIC"])
        self.assertEqual(len(codecs), MAX_CODECS)

    def test_missing_stream_describes_the_config_source(self):
        state = missing_stream("cam", ["rtsp://admin:hunter2@10.0.0.5/stream1"])
        self.assertFalse(state["configured"])
        self.assertFalse(state["connected"])
        self.assertEqual(state["source"], "rtsp://10.0.0.5")
        self.assertIsNone(missing_stream("cam")["source"])


class TestFetchStreams(unittest.TestCase):
    def fetch(self, **response: Any) -> dict[str, Any] | None:
        with patch(
            "frigate.fork.go2rtc_state.requests.get",
            return_value=Mock(**response),
        ) as get:
            result = fetch_streams()
        get.assert_called_once_with(GO2RTC_STREAMS_URL, timeout=2)
        return result

    def test_returns_the_streams(self):
        payload = {"cam": {"producers": []}}
        self.assertEqual(self.fetch(ok=True, json=Mock(return_value=payload)), payload)

    def test_unreachable(self):
        with patch(
            "frigate.fork.go2rtc_state.requests.get", side_effect=ConnectTimeout()
        ):
            self.assertIsNone(fetch_streams())

    def test_error_status(self):
        self.assertIsNone(self.fetch(ok=False, status_code=502))

    def test_body_that_is_not_json(self):
        self.assertIsNone(self.fetch(ok=True, json=Mock(side_effect=ValueError())))

    def test_json_that_is_not_an_object(self):
        self.assertIsNone(self.fetch(ok=True, json=Mock(return_value=[])))


class TestRateTracker(unittest.TestCase):
    def test_first_sample_has_no_rate(self):
        self.assertIsNone(RateTracker().sample("cam", 1000, 10.0))

    def test_rate_between_samples(self):
        rates = RateTracker()
        rates.sample("cam", 1000, 10.0)
        self.assertEqual(rates.sample("cam", 6000, 20.0), 500.0)
        self.assertEqual(rates.sample("cam", 6000, 25.0), 0.0)

    def test_counter_that_went_backwards_has_no_rate_then_recovers(self):
        rates = RateTracker()
        rates.sample("cam", 9000, 10.0)
        self.assertIsNone(rates.sample("cam", 100, 20.0))
        self.assertEqual(rates.sample("cam", 1100, 30.0), 100.0)

    def test_clock_that_did_not_advance_has_no_rate(self):
        rates = RateTracker()
        rates.sample("cam", 1000, 10.0)
        self.assertIsNone(rates.sample("cam", 2000, 10.0))

    def test_streams_are_tracked_separately_and_can_be_forgotten(self):
        rates = RateTracker()
        rates.sample("a", 0, 0.0)
        rates.sample("b", 0, 0.0)
        rates.keep(["a"])
        self.assertEqual(rates.sample("a", 100, 10.0), 10.0)
        self.assertIsNone(rates.sample("b", 100, 10.0))

    def test_concurrent_samples_keep_one_entry_per_stream(self):
        rates = RateTracker()

        def work(offset: int) -> None:
            for step in range(200):
                rates.sample(f"cam{step % 5}", step, float(offset + step))

        threads = [threading.Thread(target=work, args=(n,)) for n in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        rates.keep([])
        self.assertIsNone(rates.sample("cam0", 1, 1.0))


class TestReader(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.payload: dict[str, Any] | None = {
            "cam": {"producers": [connected_producer("rtsp://10.0.0.5/1", 1000)]}
        }
        self.fetch = Mock(side_effect=lambda: self.payload)
        self.reader = Go2rtcStateReader(
            fetch=self.fetch,
            clock=lambda: self.now,
            wall_clock=lambda: 1_790_000_000.0 + self.now,
        )

    def test_snapshot_shape_and_first_rate(self):
        snapshot = self.reader.read()
        self.assertTrue(snapshot["available"])
        self.assertEqual(snapshot["updated"], 1_790_000_100.0)
        self.assertEqual(list(snapshot["streams"]), ["cam"])
        self.assertIsNone(snapshot["streams"]["cam"]["bytes_per_second"])

    def test_cache_serves_repeat_reads_for_five_seconds(self):
        first = self.reader.read()
        self.now += 4.9
        self.assertIs(self.reader.read(), first)
        self.fetch.assert_called_once()
        self.now += 0.1
        self.assertIsNot(self.reader.read(), first)
        self.assertEqual(self.fetch.call_count, 2)

    def test_rate_comes_from_the_previous_fetch(self):
        self.reader.read()
        self.now += 10
        self.payload = {
            "cam": {"producers": [connected_producer("rtsp://10.0.0.5/1", 26_000)]}
        }
        self.assertEqual(
            self.reader.read()["streams"]["cam"]["bytes_per_second"], 2500.0
        )

    def test_unavailable_is_cached_and_resets_the_rates(self):
        self.reader.read()
        self.now += 10
        self.payload = None
        snapshot = self.reader.read()
        self.assertEqual(
            snapshot,
            {"available": False, "updated": 1_790_000_110.0, "streams": {}},
        )
        self.now += 1
        self.assertIs(self.reader.read(), snapshot)
        self.assertEqual(self.fetch.call_count, 2)

        self.now += 10
        self.payload = {
            "cam": {"producers": [connected_producer("rtsp://10.0.0.5/1", 50)]}
        }
        self.assertIsNone(self.reader.read()["streams"]["cam"]["bytes_per_second"])

    def test_concurrent_reads_share_one_fetch(self):
        started = threading.Event()
        release = threading.Event()

        def slow_fetch() -> dict[str, Any]:
            started.set()
            release.wait(5)
            return {}

        fetch = Mock(side_effect=slow_fetch)
        reader = Go2rtcStateReader(fetch=fetch, clock=lambda: 1.0)
        results: list[dict[str, Any]] = []
        threads = [
            threading.Thread(target=lambda: results.append(reader.read()))
            for _ in range(4)
        ]
        for thread in threads:
            thread.start()
        started.wait(5)
        release.set()
        for thread in threads:
            thread.join(5)
        fetch.assert_called_once()
        self.assertEqual(len(results), 4)

    def test_defaults_use_the_real_fetch(self):
        with patch(
            "frigate.fork.go2rtc_state.requests.get", side_effect=ConnectTimeout()
        ):
            # The default argument is bound at definition time, so the patch
            # has to be on requests, not on fetch_streams.
            self.assertFalse(Go2rtcStateReader().read()["available"])


class TestCameraStates(unittest.TestCase):
    def test_streams_per_camera_with_missing_ones_described_from_config(self):
        stream = reduce_stream(
            "front_door", {"producers": [connected_producer("rtsp://10.0.0.5/1")]}
        )
        body = camera_states(
            {"available": True, "updated": 5.0, "streams": {"front_door": stream}},
            {"front_door": ["front_door", "front_door_sub"], "garage": []},
            {"front_door_sub": ["rtsp://admin:hunter2@10.0.0.5/stream1?token=tok123"]},
        )
        self.assertTrue(body["available"])
        self.assertEqual(body["updated"], 5.0)
        self.assertEqual(body["cameras"]["garage"], {"streams": []})
        first, second = body["cameras"]["front_door"]["streams"]
        self.assertIs(first, stream)
        self.assertEqual(second["name"], "front_door_sub")
        self.assertFalse(second["configured"])
        self.assertEqual(second["source"], "rtsp://10.0.0.5")

    def test_unavailable_lists_no_cameras(self):
        body = camera_states(
            {"available": False, "updated": 5.0, "streams": {}},
            {"front_door": ["front_door"]},
            {},
        )
        self.assertEqual(body, {"available": False, "updated": 5.0, "cameras": {}})


if __name__ == "__main__":
    unittest.main()
