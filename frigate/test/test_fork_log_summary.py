"""Collapsed log summaries per camera and hour (I58)."""

import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

from frigate.fork import log_summary
from frigate.fork.log_summary import (
    CameraMatcher,
    normalize,
    redact,
    summarize_logs,
)

NOW = datetime(2026, 9, 29, 21, 30, 0)
LEAK_MARKER = "hunter2Secret"
USER = "camadmin"
SECRETS = (LEAK_MARKER, USER, "password", "channel0_ext", "app=bcs", "1935")


def _stamp(when: datetime) -> str:
    return when.strftime("%Y-%m-%d %H:%M:%S")


def frigate_line(when: datetime, logger: str, level: str, message: str) -> str:
    """One line the way s6 writes the frigate service's output."""
    stamp = _stamp(when)
    return f"{stamp}.107108146  [{stamp}] {logger:<30} {level:<8}: {message}\n"


def go2rtc_line(when: datetime, level: str, message: str) -> str:
    """One line the way s6 writes go2rtc's output."""
    return (
        f"{_stamp(when)}.301771246  {when.strftime('%H:%M:%S')}.301 {level} {message}\n"
    )


def watchdog(when: datetime, camera: str = "doorbell", seconds: int = 20) -> str:
    return frigate_line(
        when,
        f"watchdog.{camera}",
        "INFO",
        f"No frames received from {camera} in {seconds} seconds. Exiting ffmpeg...",
    )


def ffmpeg_error(when: datetime, camera: str = "doorbell") -> str:
    return frigate_line(
        when,
        f"ffmpeg.{camera}.audio",
        "ERROR",
        f"Error opening input file rtsp://127.0.0.1:8554/{camera}.",
    )


def go2rtc_timeout(when: datetime, pointer: int = 0x5AA53FD52080) -> str:
    return go2rtc_line(
        when,
        "WRN",
        f'[rtsp] error="streams: exec/rtsp\\n[tcp @ {pointer:#x}] Connection to '
        "tcp://10.27.99.42:80 failed: Connection timed out\\n[in#0 @ "
        f'{pointer + 64:#x}] Error opening input: Connection timed out"',
    )


def go2rtc_producer(when: datetime, port: int = 35836) -> str:
    return go2rtc_line(
        when,
        "WRN",
        "github.com/AlexxIT/go2rtc/internal/streams/producer.go:170 > "
        f'error="read tcp 127.0.0.1:8554->127.0.0.1:{port}: i/o timeout" '
        "url=ffmpeg:http://10.27.99.43/flv?port=1935&app=bcs&stream=channel0_ext.bcs"
        f"&user={USER}&password={LEAK_MARKER}",
    )


MATCHER = CameraMatcher(
    {
        "doorbell": "doorbell",
        "garage": "garage",
        "garage_2": "garage_2",
        "10.27.99.42": "doorbell",
        "10.27.99.43": "garage",
        "10.27.99.50": None,
    }
)


class LogFiles(unittest.TestCase):
    """Write fixture logs to a temp directory and summarize them."""

    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.paths = {
            "frigate": os.path.join(directory.name, "frigate"),
            "go2rtc": os.path.join(directory.name, "go2rtc"),
        }

    def write(self, service: str, lines: list[str] | bytes) -> None:
        data = lines if isinstance(lines, bytes) else "".join(lines).encode()
        with open(self.paths[service], "wb") as handle:
            handle.write(data)

    def summarize(self, **kwargs):
        kwargs.setdefault("matcher", MATCHER)
        kwargs.setdefault("paths", self.paths)
        kwargs.setdefault("now", NOW.timestamp())
        return summarize_logs(**kwargs)


class TestRedact(unittest.TestCase):
    def test_userinfo_is_dropped_not_masked(self):
        text = redact(
            f"Error opening rtsp://{USER}:{LEAK_MARKER}@10.0.0.9:554/h264/ch1"
        )
        self.assertEqual(text, "Error opening rtsp://10.0.0.9:554/h264/ch1")

    def test_query_string_and_fragment_are_dropped(self):
        text = redact(
            "url=ffmpeg:http://10.27.99.43/flv?port=1935&app=bcs&stream=channel0_ext"
            f"&user={USER}&password={LEAK_MARKER}#video=copy next"
        )
        self.assertEqual(text, "url=ffmpeg:http://10.27.99.43/flv next")

    def test_password_with_at_slash_and_quote_leaves_nothing_behind(self):
        for password in ("p@ss/w@rd", 'pa"ss', "pa\\ss", "p?a=b"):
            with self.subTest(password=password):
                text = redact(f"rtsp://{USER}:{password}@cam.lan/stream")
                self.assertEqual(text, "rtsp://cam.lan/stream")

    def test_password_with_a_space_is_not_mistaken_for_a_host(self):
        text = redact(f"open rtsp://{USER}:pa ss@10.0.0.9/stream failed")
        self.assertNotIn(USER, text)
        self.assertNotIn("pa", text)
        self.assertNotIn("ss@", text)
        self.assertIn("rtsp://<redacted>", text)

    def test_numeric_password_prefix_is_not_kept_as_a_port(self):
        text = redact(f"rtsp://{USER}:12345abc def@10.0.0.9/stream")
        self.assertNotIn(USER, text)
        self.assertNotIn("12345", text)

    def test_credentials_in_the_path_are_cut(self):
        text = redact(
            f"rtsp://10.0.0.9:554/user={USER}_password={LEAK_MARKER}_channel=1.sdp"
        )
        self.assertEqual(text, "rtsp://10.0.0.9:554/user")

    def test_query_without_a_scheme_and_bare_pairs(self):
        text = redact(
            f"nest:?client_id=abc&client_secret={LEAK_MARKER} token={LEAK_MARKER} ok=1"
        )
        self.assertNotIn(LEAK_MARKER, text)
        self.assertNotIn("abc", text)
        self.assertIn("token=*", text)
        self.assertIn("ok=1", text)

    def test_closing_quote_and_ipv6_host_survive(self):
        text = redact(f'error="dial rtsp://{USER}:{LEAK_MARKER}@[fe80::1]:554/a?b=c"')
        self.assertEqual(text, 'error="dial rtsp://[fe80::1]:554/a"')

    def test_url_without_a_host_is_replaced(self):
        self.assertEqual(redact("bad rtsp://?x=1 url"), "bad rtsp://<redacted> url")

    def test_secret_pair_keeps_leading_dots_and_the_whole_key(self):
        self.assertEqual(redact(" .api.Token=abc x"), " .api.Token=* x")
        self.assertEqual(redact("a=pass=b c=d"), "a=pass=* c=d")
        self.assertEqual(redact("pa.ss=b"), "pa.ss=b")

    def test_dangling_userinfo_is_cut_up_to_the_last_at(self):
        self.assertEqual(redact("x pa@ss@host y"), "x host y")
        self.assertEqual(redact("x @host y"), "x @host y")

    def test_long_runs_without_a_match_are_redacted_quickly(self):
        # The previous patterns backtracked over these in quadratic time.
        started = time.perf_counter()
        redact("a." * 20000 + "=1 " + "@" * 20000)
        self.assertLess(time.perf_counter() - started, 1.0)

    def test_escaped_newlines_become_spaces(self):
        self.assertEqual(redact("a\\n[tcp @ 0x1f] b​c"), "a [tcp @ 0x1f] b c")

    def test_normalize_replaces_numbers_and_pointers(self):
        self.assertEqual(
            normalize("[tcp @ 0x5aa53fd52080] 10.27.99.42:80 in 20 seconds"),
            "[tcp @ #] #.#.#.#:# in # seconds",
        )


class TestCameraMatcher(unittest.TestCase):
    def test_empty_matcher_matches_nothing(self):
        self.assertIsNone(CameraMatcher().match("doorbell"))

    def test_names_do_not_match_inside_longer_names_or_hosts(self):
        self.assertEqual(MATCHER.match("the garage is offline"), "garage")
        self.assertEqual(MATCHER.match("the Garage_2 is offline"), "garage_2")
        self.assertIsNone(MATCHER.match("garage_20 and mygarage and garage-x"))
        self.assertEqual(MATCHER.match("tcp://10.27.99.42:80 failed"), "doorbell")
        self.assertEqual(MATCHER.match("reached 10.27.99.42."), "doorbell")
        self.assertIsNone(MATCHER.match("tcp://10.27.99.421:80 and 110.27.99.42"))

    def test_shared_token_attributes_to_nothing_but_later_token_can(self):
        self.assertIsNone(MATCHER.match("nvr 10.27.99.50 down"))
        self.assertEqual(MATCHER.match("nvr 10.27.99.50 feeds garage"), "garage")

    def test_from_config_maps_hosts_and_streams_to_cameras(self):
        def camera(paths, live=None):
            return SimpleNamespace(
                ffmpeg=SimpleNamespace(
                    inputs=[SimpleNamespace(path=path) for path in paths]
                ),
                live=SimpleNamespace(streams=live if live is not None else []),
            )

        config = SimpleNamespace(
            cameras={
                "doorbell": camera(["rtsp://127.0.0.1:8554/doorbell_main?video"]),
                "garage": camera(
                    [f"rtsp://{USER}:{LEAK_MARKER}@10.0.0.7:554/ch1"],
                    live={"Main": "garage_hd"},
                ),
                "nvr_a": camera(["rtsp://10.0.0.99/a"]),
                "nvr_b": camera(["rtsp://10.0.0.99/b"]),
            },
            go2rtc=SimpleNamespace(
                model_dump=lambda: {
                    "streams": {
                        "doorbell_main": [
                            f"ffmpeg:http://10.27.99.42/flv?user={USER}&password={LEAK_MARKER}",
                            "ffmpeg:doorbell_main#audio=opus",
                            # an owned stream's loopback source names no camera
                            "rtsp://127.0.0.1:8554/doorbell_sub",
                        ],
                        "garage_hd": f"rtsp://{USER}:{LEAK_MARKER}@garage-cam.lan/hd",
                        "orphan": ["rtsp://10.0.0.200/x"],
                        "loop": ["rtsp://127.0.0.1:8554/other"],
                        "broken": 7,
                    }
                }
            ),
        )
        matcher = CameraMatcher.from_config(config)
        self.assertEqual(
            matcher.match("Connection to tcp://10.27.99.42:80"), "doorbell"
        )
        self.assertEqual(matcher.match("stream=doorbell_main"), "doorbell")
        self.assertEqual(matcher.match("dial 10.0.0.7:554"), "garage")
        self.assertEqual(matcher.match("dial GARAGE-CAM.lan"), "garage")
        self.assertEqual(matcher.match("garage_hd has no producer"), "garage")
        self.assertIsNone(matcher.match("dial 10.0.0.99"))
        self.assertIsNone(matcher.match("dial 10.0.0.200 for orphan"))
        self.assertIsNone(matcher.match("127.0.0.1:8554"))
        self.assertEqual(matcher.match("nvr_b is down"), "nvr_b")

    def test_from_config_tolerates_missing_or_odd_go2rtc(self):
        cameras = {"porch": SimpleNamespace()}
        for go2rtc in (
            None,
            {"streams": None},
            {"streams": {"porch": "rtsp://h/x"}},
            5,
        ):
            with self.subTest(go2rtc=go2rtc):
                matcher = CameraMatcher.from_config(
                    SimpleNamespace(cameras=cameras, go2rtc=go2rtc)
                )
                self.assertEqual(matcher.match("porch offline"), "porch")
        self.assertIsNone(CameraMatcher.from_config(SimpleNamespace()).match("porch"))


class TestSummarizeLogs(LogFiles):
    def test_groups_interleaved_cameras_and_never_returns_credentials(self):
        start = NOW - timedelta(minutes=20)
        frigate, go2rtc = [], []
        for i in range(30):
            when = start + timedelta(seconds=20 * i)
            frigate.append(watchdog(when, "doorbell", 20 + i))
            frigate.append(ffmpeg_error(when, "doorbell"))
            frigate.append(watchdog(when, "garage"))
            frigate.append(
                frigate_line(when, "frigate.record.maintainer", "INFO", f"kept {i}")
            )
            go2rtc.append(go2rtc_timeout(when, 0x5AA53FD52080 + i * 4096))
            go2rtc.append(go2rtc_producer(when, 35000 + i))
            go2rtc.append(go2rtc_line(when, "INF", "[streams] start producer"))
        frigate.append(
            frigate_line(start, "frigate.app", "WARNING", "one-off about garage_2")
        )
        self.write("frigate", frigate)
        self.write("go2rtc", go2rtc)

        result = self.summarize()

        dumped = json.dumps(result)
        for secret in SECRETS:
            self.assertNotIn(secret, dumped)
        self.assertNotIn("?", dumped)
        self.assertNotIn("@1", dumped)
        self.assertEqual(
            result["cameras"], {"doorbell": 90, "garage": 60, "garage_2": 1}
        )
        self.assertEqual(list(result["cameras"]), ["doorbell", "garage", "garage_2"])
        self.assertEqual(result["total"], 151)
        self.assertEqual(result["unattributed"], 0)
        self.assertFalse(result["truncated"])
        groups = {
            (group["camera"], group["service"], group["level"]): group
            for group in result["groups"]
        }
        self.assertEqual(
            set(groups),
            {
                ("doorbell", "frigate", "info"),
                ("doorbell", "frigate", "error"),
                ("garage", "frigate", "info"),
                ("doorbell", "go2rtc", "warning"),
                ("garage", "go2rtc", "warning"),
            },
        )
        for group in groups.values():
            self.assertEqual(group["count"], 30)
            self.assertEqual(group["first"], start.timestamp())
            self.assertEqual(
                group["last"], (start + timedelta(seconds=580)).timestamp()
            )
            self.assertEqual(group["hour"], NOW.replace(minute=0, second=0).timestamp())
        self.assertEqual(
            groups[("garage", "go2rtc", "warning")]["message"],
            "github.com/AlexxIT/go2rtc/internal/streams/producer.go:170 > "
            'error="read tcp 127.0.0.1:8554->127.0.0.1:35000: i/o timeout" '
            "url=ffmpeg:http://10.27.99.43/flv",
        )
        self.assertEqual(
            groups[("doorbell", "frigate", "error")]["message"],
            "Error opening input file rtsp://127.0.0.1:8554/doorbell.",
        )
        self.assertIn(
            "Connection to tcp://10.27.99.42:80 failed",
            groups[("doorbell", "go2rtc", "warning")]["message"],
        )
        self.assertEqual(
            groups[("doorbell", "frigate", "info")]["signature"],
            "No frames received from doorbell in # seconds. Exiting ffmpeg...",
        )

    def test_buckets_by_hour_and_sorts_by_count(self):
        hour = NOW.replace(minute=0, second=0)
        lines = [
            watchdog(hour - timedelta(hours=1, minutes=-5, seconds=-i))
            for i in range(3)
        ]
        lines += [watchdog(hour + timedelta(minutes=1, seconds=i)) for i in range(5)]
        self.write("frigate", lines)

        groups = self.summarize()["groups"]

        self.assertEqual([group["count"] for group in groups], [5, 3])
        self.assertEqual(groups[0]["hour"], hour.timestamp())
        self.assertEqual(groups[1]["hour"], (hour - timedelta(hours=1)).timestamp())
        self.assertEqual(groups[0]["signature"], groups[1]["signature"])

    def test_window_min_count_and_camera_filter(self):
        old = NOW - timedelta(hours=30)
        recent = NOW - timedelta(minutes=10)
        self.write(
            "frigate",
            [watchdog(old), watchdog(old)]
            + [watchdog(recent + timedelta(seconds=i)) for i in range(3)]
            + [ffmpeg_error(recent, "garage")],
        )

        day = self.summarize()
        self.assertEqual(day["total"], 4)
        self.assertEqual(day["hours"], 24)
        self.assertEqual(day["start"], (NOW - timedelta(hours=24)).timestamp())
        self.assertEqual(day["covered_from"], (NOW - timedelta(hours=24)).timestamp())
        self.assertEqual(day["sources"]["frigate"]["covered_from"], old.timestamp())
        self.assertEqual([group["count"] for group in day["groups"]], [3])

        self.assertEqual(self.summarize(hours=48)["total"], 6)
        self.assertEqual(self.summarize(hours=9999)["hours"], 168)
        self.assertEqual(self.summarize(hours=0)["hours"], 1)
        self.assertEqual(len(self.summarize(min_count=1)["groups"]), 2)
        self.assertEqual(len(self.summarize(min_count=0)["groups"]), 2)

        garage = self.summarize(camera="garage", min_count=1)
        self.assertEqual(garage["cameras"], {"garage": 1})
        self.assertEqual([group["camera"] for group in garage["groups"]], ["garage"])
        self.assertEqual(self.summarize(camera="nobody")["total"], 0)

    def test_covered_from_is_the_oldest_line_inside_the_window(self):
        first = NOW - timedelta(hours=2)
        self.write("go2rtc", [go2rtc_timeout(first), go2rtc_timeout(NOW)])

        result = self.summarize()

        self.assertEqual(result["covered_from"], first.timestamp())
        self.assertEqual(
            result["sources"]["go2rtc"],
            {
                "available": True,
                "partial": False,
                "lines": 2,
                "covered_from": first.timestamp(),
                "covered_to": NOW.timestamp(),
            },
        )

    def test_level_filter_and_watchdog_info_switch(self):
        when = NOW - timedelta(minutes=5)
        self.write(
            "frigate",
            [
                watchdog(when),
                frigate_line(when, "frigate.app", "INFO", "doorbell is fine"),
                frigate_line(when, "frigate.app", "WARNING", "doorbell is slow"),
                frigate_line(when, "audio.doorbell", "ERROR", "audio died"),
                frigate_line(when, "frigate.app", "CRITICAL", "boom"),
                frigate_line(when, "frigate.app", "DEBUG", "WARNING in the text"),
            ],
        )
        self.write(
            "go2rtc",
            [
                go2rtc_line(when, "ERR", "[api] doorbell listen failed"),
                go2rtc_line(when, "WRN", "[rtsp] doorbell slow"),
                go2rtc_line(when, "DBG", "[rtsp]  WRN  in the text"),
            ],
        )

        def levels(**kwargs):
            groups = self.summarize(min_count=1, **kwargs)["groups"]
            return sorted((group["service"], group["level"]) for group in groups)

        self.assertEqual(
            levels(),
            [
                ("frigate", "error"),
                ("frigate", "error"),
                ("frigate", "info"),
                ("frigate", "warning"),
                ("go2rtc", "error"),
                ("go2rtc", "warning"),
            ],
        )
        self.assertEqual(
            levels(watchdog_info=False, levels=["ERROR"]),
            [("frigate", "error"), ("frigate", "error"), ("go2rtc", "error")],
        )
        self.assertEqual(
            levels(watchdog_info=False, levels=["info"]),
            [("frigate", "info"), ("frigate", "info")],
        )
        unattributed = self.summarize(min_count=1, levels=["error"])
        self.assertEqual(unattributed["unattributed"], 1)
        self.assertIn(None, [group["camera"] for group in unattributed["groups"]])

    def test_group_keeps_the_highest_level(self):
        when = NOW - timedelta(minutes=5)
        self.write(
            "frigate",
            [
                frigate_line(
                    when, "ffmpeg.doorbell.detect", "WARNING", "stream 1 broke"
                ),
                frigate_line(when, "ffmpeg.doorbell.detect", "ERROR", "stream 2 broke"),
                frigate_line(
                    when, "ffmpeg.doorbell.detect", "WARNING", "stream 3 broke"
                ),
            ],
        )

        (group,) = self.summarize()["groups"]

        self.assertEqual((group["count"], group["level"]), (3, "error"))
        self.assertEqual(group["message"], "stream 1 broke")

    def test_example_is_truncated(self):
        when = NOW - timedelta(minutes=5)
        self.write(
            "frigate",
            [frigate_line(when, "frigate.app", "ERROR", "x" * 900)] * 2,
        )

        (group,) = self.summarize()["groups"]

        self.assertEqual(len(group["message"]), log_summary.EXAMPLE_CHARS)
        self.assertEqual(len(group["signature"]), log_summary.SIGNATURE_CHARS)

    def test_group_cap_keeps_the_highest_counts(self):
        when = NOW - timedelta(minutes=5)
        lines = []
        for index, word in enumerate(["alpha", "beta", "gamma", "delta"]):
            lines += [frigate_line(when, "frigate.app", "ERROR", f"{word} failed")] * (
                index + 2
            )
        self.write("frigate", lines)

        result = self.summarize(max_groups=2)

        self.assertTrue(result["truncated"])
        self.assertEqual(
            [group["message"] for group in result["groups"]],
            ["delta failed", "gamma failed"],
        )
        self.assertEqual(result["total"], 14)
        self.assertEqual(self.summarize(max_groups=-1)["groups"], [])

    def test_tracked_groups_are_bounded(self):
        when = NOW - timedelta(minutes=5)
        words = ["alpha", "beta", "gamma", "delta"]
        self.write(
            "frigate",
            [
                frigate_line(when, "frigate.app", "ERROR", f"{word} failed")
                for word in words
            ]
            * 2,
        )

        with (
            patch.object(log_summary, "MAX_TRACKED_GROUPS", 2),
            patch.object(log_summary, "_PARSE_CACHE_MAX", 2),
        ):
            result = self.summarize()

        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["groups"]), 2)
        self.assertEqual(result["total"], 8)

    def test_reads_only_the_end_of_a_large_file_and_drops_the_cut_line(self):
        start = NOW - timedelta(hours=1)
        lines = [watchdog(start + timedelta(seconds=i)) for i in range(2000)]
        self.write("frigate", lines)
        line_bytes = len(lines[0])

        # 100.5 lines from the end: the read starts in the middle of a line.
        result = self.summarize(max_mb=line_bytes * 100.5 / (1024 * 1024))

        source = result["sources"]["frigate"]
        self.assertTrue(source["partial"])
        self.assertEqual(source["lines"], 100)
        self.assertEqual(result["total"], 100)
        self.assertEqual(
            source["covered_from"], (start + timedelta(seconds=1900)).timestamp()
        )

    def test_undecodable_bytes_short_and_foreign_lines_are_tolerated(self):
        when = NOW - timedelta(minutes=5)
        stamp = _stamp(when)
        data = b"".join(
            [
                b"\xff\xfe garbage WARNING\n",
                b"\n",
                b"short\n",
                b"Traceback (most recent call last): ERROR\n",
                f"{stamp}.1 no double space WARNING\n".encode(),
                f"{stamp}.107108146  no bracket WARNING\n".encode(),
                f"{stamp}.107108146  [{stamp} unclosed WARNING\n".encode(),
                f"{stamp}.107108146  [{stamp}] no separator WARNING\n".encode(),
                f"{stamp}.107108146  [{stamp}] a b c WARNING : x\n".encode(),
                f"{stamp}.107108146  [{stamp}] frigate.app NOTICE  : WARNING\n".encode(),
                f"2026-13-40 99:99:99.107108146  [{stamp}] bad date WARNING\n".encode(),
                watchdog(when).encode().replace(b"Exiting", b"Exit\xffing"),
                watchdog(when).encode().replace(b"Exiting", b"Exit\xffing"),
                # The last line is still being written.
                watchdog(when).encode()[:60],
            ]
        )
        self.write("frigate", data)
        self.write(
            "go2rtc",
            f"{stamp}.3  WRN\n{stamp}.3  12:00:00.000 WRN \n".encode()
            + b"[INFO] Preparing go2rtc config... WRN \n",
        )

        result = self.summarize()

        self.assertEqual(result["total"], 2)
        (group,) = result["groups"]
        self.assertEqual(group["count"], 2)
        self.assertIn("Exit�ing ffmpeg", group["message"])

    def test_missing_files_give_an_empty_summary(self):
        result = self.summarize()

        self.assertEqual(result["groups"], [])
        self.assertEqual(result["cameras"], {})
        self.assertEqual(result["total"], 0)
        self.assertIsNone(result["covered_from"])
        self.assertEqual(
            result["sources"]["go2rtc"],
            {
                "available": False,
                "partial": False,
                "lines": 0,
                "covered_from": None,
                "covered_to": None,
            },
        )

    def test_unknown_services_are_skipped_and_defaults_are_the_real_paths(self):
        result = summarize_logs(paths={"nginx": "/nonexistent"}, now=NOW.timestamp())
        self.assertEqual(result["sources"], {})
        self.assertEqual(
            log_summary.LOG_PATHS,
            {
                "frigate": "/dev/shm/logs/frigate/current",
                "go2rtc": "/dev/shm/logs/go2rtc/current",
            },
        )

    def test_without_a_matcher_only_logger_names_attribute(self):
        when = NOW - timedelta(minutes=5)
        self.write(
            "frigate",
            [
                watchdog(when),
                frigate_line(when, "frigate.app", "ERROR", "doorbell died"),
            ],
        )
        self.write("go2rtc", [go2rtc_timeout(when)])

        result = self.summarize(matcher=None, min_count=1)

        self.assertEqual(result["cameras"], {"doorbell": 1})
        self.assertEqual(result["unattributed"], 2)

    def test_defaults_read_the_real_paths_against_the_real_clock(self):
        when = datetime.now() - timedelta(minutes=5)
        self.write("frigate", [watchdog(when), watchdog(when)])

        with patch.object(log_summary, "LOG_PATHS", self.paths):
            result = summarize_logs()

        self.assertEqual(result["cameras"], {"doorbell": 2})
        self.assertEqual(result["hours"], 24)
        self.assertFalse(result["sources"]["go2rtc"]["available"])

    def test_ten_megabytes_per_log_are_summarized_quickly(self):
        start = NOW - timedelta(hours=20)
        frigate, go2rtc = [], []
        for i in range(30000):
            when = start + timedelta(seconds=2 * i)
            frigate.append(watchdog(when))
            frigate.append(ffmpeg_error(when))
            go2rtc.append(go2rtc_timeout(when, 0x5AA53FD52080 + i * 64))
            go2rtc.append(go2rtc_producer(when, 30000 + i % 5000))
        self.write("frigate", frigate)
        self.write("go2rtc", go2rtc)
        megabyte = 1024 * 1024
        self.assertGreater(os.path.getsize(self.paths["go2rtc"]), 10 * megabyte)

        started = time.perf_counter()
        result = self.summarize()
        elapsed = time.perf_counter() - started

        # Generous for a loaded CI runner; it takes well under a second.
        self.assertLess(elapsed, 5.0)
        self.assertFalse(result["sources"]["frigate"]["partial"])
        self.assertTrue(result["sources"]["go2rtc"]["partial"])
        kept = result["sources"]["go2rtc"]["lines"]
        self.assertLess(kept, 60000)
        self.assertEqual(result["total"], 60000 + kept)
        self.assertEqual(set(result["cameras"]), {"doorbell", "garage"})
        dumped = json.dumps(result)
        for secret in SECRETS:
            self.assertNotIn(secret, dumped)


if __name__ == "__main__":
    unittest.main()
