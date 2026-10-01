"""Tests for pinging cameras from Frigate and passing the result on (I60)."""

import asyncio
import socket
import struct
import unittest
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import aiohttp

from frigate.fork import camera_ping
from frigate.fork.camera_ping import (
    ATTEMPTS,
    CameraPinger,
    PingState,
    build_echo,
    camera_ping_round,
    camera_ping_sampler,
    camera_targets,
    icmp_echo,
    is_reply,
    ping_cameras,
    push_params,
    push_states,
    push_urls,
    send_push,
    source_target,
    tcp_connect,
)

SOURCE = "rtsp://camuser:hunter2@10.0.0.1:554/Streaming/Channels/101?token=tok123"
PUSH_URL = "http://kuma.lan:3001/api/push/s3crettoken"
TOKEN = b"12345678"


def config(
    cameras: dict[str, dict[str, Any]], streams: dict[str, Any] | None = None
) -> SimpleNamespace:
    return SimpleNamespace(
        go2rtc=SimpleNamespace(model_dump=lambda: {"streams": streams}),
        cameras={
            name: SimpleNamespace(
                enabled=spec.get("enabled", True),
                live=SimpleNamespace(streams=spec.get("live", {name: name})),
                ffmpeg=SimpleNamespace(
                    inputs=[SimpleNamespace(path=p) for p in spec.get("inputs", [])]
                ),
            )
            for name, spec in cameras.items()
        },
    )


def state(**overrides: Any) -> PingState:
    result: PingState = {
        "reachable": True,
        "ms": 4.2,
        "loss": 0.0,
        "method": "icmp",
        "checked": 100.0,
    }
    result.update(overrides)  # type: ignore[typeddict-item]
    return result


def reply(sequence: int, token: bytes, kind: int = 0) -> bytes:
    return struct.pack("!BBHHH", kind, 0, 0, 77, sequence) + token


class TestSourceTarget(unittest.TestCase):
    def test_host_and_port_without_credentials(self):
        self.assertEqual(source_target(SOURCE), ("10.0.0.1", 554))

    def test_default_port_comes_from_the_scheme(self):
        self.assertEqual(source_target("rtsp://u:p@cam.lan/stream"), ("cam.lan", 554))
        self.assertEqual(source_target("https://cam.lan/x"), ("cam.lan", 443))

    def test_prefix_module_uses_the_inner_scheme(self):
        self.assertEqual(
            source_target("ffmpeg:http://10.0.0.2/flv?user=a&password=b#video=copy"),
            ("10.0.0.2", 80),
        )

    def test_scheme_without_a_known_port(self):
        self.assertEqual(source_target("kasa://10.0.0.9/path"), ("10.0.0.9", None))

    def test_ipv6_host_loses_its_brackets(self):
        self.assertEqual(source_target("rtsp://[fd00::5]:8554/x"), ("fd00::5", 8554))

    def test_loopback_and_hostless_sources_have_no_target(self):
        for source in (
            "rtsp://127.0.0.1:8554/front_door",
            "rtsp://localhost:8554/front_door",
            "exec:ffmpeg -i rtsp://u:p@10.0.0.1/x",
            "ffmpeg:front_door#audio=opus",
            "rtsp://user:pa/ss@10.0.0.1/x",
            "",
        ):
            self.assertIsNone(source_target(source), source)


class TestCameraTargets(unittest.TestCase):
    def test_restreamed_camera_resolves_through_its_go2rtc_stream(self):
        targets = camera_targets(
            config(
                {"front": {"inputs": ["rtsp://127.0.0.1:8554/front"]}},
                {"front": [SOURCE]},
            )
        )
        self.assertEqual(targets, {"front": ("10.0.0.1", 554)})

    def test_first_source_with_a_host_wins(self):
        targets = camera_targets(
            config(
                {"front": {"inputs": ["rtsp://127.0.0.1:8554/front_sub"]}},
                {
                    "front": ["ffmpeg:front_sub#audio=opus", "rtsp://u:p@10.0.0.7/1"],
                    "front_sub": ["rtsp://u:p@10.0.0.8/2"],
                },
            )
        )
        self.assertEqual(targets, {"front": ("10.0.0.7", 554)})

    def test_direct_ffmpeg_input_without_go2rtc(self):
        targets = camera_targets(
            config({"yard": {"inputs": ["rtsp://u:p@10.0.0.3:8554/live"]}})
        )
        self.assertEqual(targets, {"yard": ("10.0.0.3", 8554)})

    def test_disabled_and_hostless_cameras_are_left_out(self):
        targets = camera_targets(
            config(
                {
                    "off": {"enabled": False, "inputs": ["rtsp://u:p@10.0.0.3/live"]},
                    "file": {"inputs": ["/media/frigate/clip.mp4"]},
                }
            )
        )
        self.assertEqual(targets, {})


class TestPushUrls(unittest.TestCase):
    def test_pairs_split_on_whitespace_and_commas(self):
        urls = push_urls(f"front={PUSH_URL}\n  yard=https://kuma.lan/api/push/b, ")
        self.assertEqual(
            urls, {"front": PUSH_URL, "yard": "https://kuma.lan/api/push/b"}
        )

    def test_query_copied_from_the_monitor_page_is_removed(self):
        urls = push_urls(f"front={PUSH_URL}?status=up&msg=OK&ping=")
        self.assertEqual(urls, {"front": PUSH_URL})

    def test_empty_value(self):
        self.assertEqual(push_urls("  "), {})

    def test_bad_entries_are_dropped_without_logging_the_url(self):
        with self.assertLogs(camera_ping.logger, "WARNING") as logs:
            urls = push_urls(f"front=ftp://kuma.lan/s3cret ={PUSH_URL} yard")
        self.assertEqual(urls, {})
        text = "\n".join(logs.output)
        self.assertIn("front", text)
        self.assertIn("yard", text)
        self.assertNotIn("s3cret", text)


class TestEchoPackets(unittest.TestCase):
    def test_request_has_a_valid_checksum(self):
        packet = build_echo(3, TOKEN)
        kind, code, _checksum, _identifier, sequence = struct.unpack(
            "!BBHHH", packet[:8]
        )
        self.assertEqual((kind, code, sequence, packet[8:]), (8, 0, 3, TOKEN))
        # A packet with a correct checksum sums to zero.
        self.assertEqual(camera_ping._checksum(packet), 0)

    def test_checksum_pads_an_odd_length(self):
        self.assertEqual(
            camera_ping._checksum(b"\x01\x02\x03"),
            camera_ping._checksum(b"\x01\x02\x03\x00"),
        )

    def test_reply_is_matched_by_sequence_and_token(self):
        self.assertTrue(is_reply(reply(3, TOKEN), 3, TOKEN))
        self.assertFalse(is_reply(reply(4, TOKEN), 3, TOKEN))
        self.assertFalse(is_reply(reply(3, b"87654321"), 3, TOKEN))

    def test_other_icmp_messages_are_not_replies(self):
        # Our own request, as a raw socket on the same host can see it.
        self.assertFalse(is_reply(reply(3, TOKEN, kind=8), 3, TOKEN))
        self.assertFalse(is_reply(b"\x00\x00", 3, TOKEN))
        self.assertFalse(is_reply(b"", 3, TOKEN))

    def test_ip_header_of_a_raw_socket_is_skipped(self):
        header = bytes([0x45]) + bytes(19)
        self.assertTrue(is_reply(header + reply(3, TOKEN), 3, TOKEN))


class FakeSocket:
    """Stands in for an ICMP socket and answers from a list."""

    def __init__(self, answers: list[Any]) -> None:
        self.answers = answers
        self.sent: list[tuple[bytes, tuple[str, int]]] = []

    def __enter__(self) -> "FakeSocket":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def settimeout(self, _timeout: float) -> None:
        return None

    def sendto(self, data: bytes, address: tuple[str, int]) -> None:
        self.sent.append((data, address))

    def recvfrom(self, _size: int) -> tuple[bytes, tuple[str, int]]:
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer


class TestIcmpEcho(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(camera_ping.secrets, "token_bytes", return_value=TOKEN)
        patcher.start()
        self.addCleanup(patcher.stop)

    def echo(self, answers: list[Any]) -> tuple[float | None, FakeSocket]:
        sock = FakeSocket(answers)
        with patch.object(camera_ping, "_icmp_socket", return_value=sock):
            return icmp_echo("10.0.0.1", 0.5, 3), sock

    def test_reply_gives_the_round_trip(self):
        elapsed, sock = self.echo([(reply(3, TOKEN), ("10.0.0.1", 0))])
        self.assertIsNotNone(elapsed)
        self.assertGreaterEqual(elapsed, 0)
        self.assertEqual(sock.sent, [(build_echo(3, TOKEN), ("10.0.0.1", 0))])

    def test_replies_from_other_hosts_and_pings_are_skipped(self):
        elapsed, _sock = self.echo(
            [
                (reply(3, TOKEN), ("10.0.0.9", 0)),
                (reply(2, TOKEN), ("10.0.0.1", 0)),
                (reply(3, TOKEN), ("10.0.0.1", 0)),
            ]
        )
        self.assertIsNotNone(elapsed)

    def test_timeout_and_network_errors_give_none(self):
        self.assertIsNone(self.echo([TimeoutError()])[0])
        self.assertIsNone(self.echo([OSError("network unreachable")])[0])

    def test_deadline_passes_without_a_matching_reply(self):
        sock = FakeSocket([(reply(9, TOKEN), ("10.0.0.1", 0))])
        with patch.object(camera_ping, "_icmp_socket", return_value=sock):
            self.assertIsNone(icmp_echo("10.0.0.1", 0.0, 3))

    def test_name_that_does_not_resolve_gives_none(self):
        with patch.object(camera_ping.socket, "gethostbyname", side_effect=OSError):
            self.assertIsNone(icmp_echo("nowhere.invalid", 0.5, 1))

    def test_refused_socket_raises_permission_error(self):
        with patch.object(camera_ping, "_icmp_socket", side_effect=PermissionError):
            with self.assertRaises(PermissionError):
                icmp_echo("10.0.0.1", 0.5, 1)

    def test_send_that_is_not_permitted_raises(self):
        with self.assertRaises(PermissionError):
            sock = FakeSocket([])
            sock.sendto = Mock(side_effect=PermissionError)  # type: ignore[method-assign]
            with patch.object(camera_ping, "_icmp_socket", return_value=sock):
                icmp_echo("10.0.0.1", 0.5, 1)

    def test_raw_socket_is_the_fallback_for_a_datagram_socket(self):
        raw = MagicMock()
        with patch.object(
            camera_ping.socket, "socket", side_effect=[PermissionError, raw]
        ) as opened:
            self.assertIs(camera_ping._icmp_socket(), raw)
        self.assertEqual(opened.call_args_list[0].args[1], socket.SOCK_DGRAM)
        self.assertEqual(opened.call_args_list[1].args[1], socket.SOCK_RAW)

    def test_datagram_socket_is_used_when_allowed(self):
        dgram = MagicMock()
        with patch.object(camera_ping.socket, "socket", return_value=dgram) as opened:
            self.assertIs(camera_ping._icmp_socket(), dgram)
        opened.assert_called_once()


class TestTcpConnect(unittest.TestCase):
    def test_listening_port_answers(self):
        with socket.socket() as server:
            server.bind(("127.0.0.1", 0))
            server.listen(1)
            port = server.getsockname()[1]
            self.assertIsNotNone(tcp_connect("127.0.0.1", port, 1.0))

    def test_refused_connection_still_counts_as_an_answer(self):
        with patch.object(
            camera_ping.socket, "create_connection", side_effect=ConnectionRefusedError
        ):
            self.assertIsNotNone(tcp_connect("10.0.0.1", 554, 1.0))

    def test_timeout_is_no_answer(self):
        with patch.object(
            camera_ping.socket, "create_connection", side_effect=socket.timeout
        ):
            self.assertIsNone(tcp_connect("10.0.0.1", 554, 1.0))


class TestCameraPinger(unittest.TestCase):
    def pinger(self, icmp: Any, tcp: Any = None) -> CameraPinger:
        return CameraPinger(
            icmp=icmp, tcp=tcp or Mock(return_value=None), clock=lambda: 100.0
        )

    def test_all_echoes_answered(self):
        icmp = Mock(side_effect=[0.0042, 0.0031, 0.0055])
        result = self.pinger(icmp).probe(("10.0.0.1", 554))
        self.assertEqual(result, state(ms=3.1))
        self.assertEqual([call.args[2] for call in icmp.call_args_list], [1, 2, 3])

    def test_lost_echoes_are_counted(self):
        icmp = Mock(side_effect=[None, 0.02, None])
        result = self.pinger(icmp).probe(("10.0.0.1", 554))
        self.assertEqual(result, state(ms=20.0, loss=0.67))

    def test_no_echo_falls_back_to_the_stream_port(self):
        tcp = Mock(return_value=0.001)
        result = self.pinger(Mock(return_value=None), tcp).probe(("10.0.0.1", 554))
        self.assertEqual(result, state(ms=1.0, method="tcp"))
        self.assertEqual(tcp.call_count, ATTEMPTS)
        tcp.assert_called_with("10.0.0.1", 554, camera_ping.TIMEOUT_SECONDS)

    def test_nothing_answers(self):
        result = self.pinger(Mock(return_value=None)).probe(("10.0.0.1", 554))
        self.assertEqual(
            result, state(reachable=False, ms=None, loss=1.0, method="tcp")
        )

    def test_no_echo_and_no_port_stays_icmp(self):
        tcp = Mock()
        result = self.pinger(Mock(return_value=None), tcp).probe(("10.0.0.1", None))
        self.assertEqual(result, state(reachable=False, ms=None, loss=1.0))
        tcp.assert_not_called()

    def test_icmp_is_tried_once_when_not_permitted(self):
        icmp = Mock(side_effect=PermissionError)
        tcp = Mock(return_value=0.002)
        pinger = self.pinger(icmp, tcp)
        with self.assertLogs(camera_ping.logger, "INFO"):
            first = pinger.probe(("10.0.0.1", 554))
        second = pinger.probe(("10.0.0.2", 554))
        self.assertEqual(first, state(ms=2.0, method="tcp"))
        self.assertEqual(second, state(ms=2.0, method="tcp"))
        icmp.assert_called_once()

    def test_not_permitted_and_no_port_is_unreachable(self):
        pinger = self.pinger(Mock(side_effect=PermissionError))
        with self.assertLogs(camera_ping.logger, "INFO"):
            result = pinger.probe(("10.0.0.1", None))
        self.assertEqual(result, state(reachable=False, ms=None, loss=1.0))


class TestPushing(unittest.IsolatedAsyncioTestCase):
    def test_params_for_an_answer_and_for_silence(self):
        self.assertEqual(
            push_params(state()),
            {"status": "up", "msg": "Ping reply in 4.2 ms", "ping": "4.2"},
        )
        self.assertEqual(
            push_params(state(reachable=False, ms=None, loss=1.0)),
            {"status": "down", "msg": "No ping reply", "ping": ""},
        )

    async def test_ping_cameras_probes_every_target(self):
        pinger = CameraPinger(icmp=Mock(return_value=0.001), clock=lambda: 100.0)
        states = await ping_cameras(
            pinger, {"front": ("10.0.0.1", 554), "yard": ("10.0.0.2", None)}
        )
        self.assertEqual(states, {"front": state(ms=1.0), "yard": state(ms=1.0)})

    async def test_only_cameras_with_a_url_and_a_result_are_pushed(self):
        send = AsyncMock(return_value=True)
        accepted = await push_states(
            {"front": PUSH_URL, "gone": "http://kuma.lan/api/push/x"},
            {"front": state(), "yard": state()},
            send,
        )
        self.assertEqual(accepted, {"front": True})
        send.assert_awaited_once_with(PUSH_URL, push_params(state()))

    async def test_round_keeps_the_states_on_the_app_and_pushes(self):
        app = SimpleNamespace(
            frigate_config=config({"front": {"inputs": ["rtsp://u:p@10.0.0.1/1"]}}),
            state=SimpleNamespace(),
        )
        send = AsyncMock(return_value=True)
        pinger = CameraPinger(icmp=Mock(return_value=0.001), clock=lambda: 100.0)

        states = await camera_ping_round(app, pinger, {"front": PUSH_URL}, send)

        self.assertEqual(states, {"front": state(ms=1.0)})
        self.assertEqual(app.state.fork_camera_ping, states)
        send.assert_awaited_once()

    async def test_send_push_reports_whether_it_was_accepted(self):
        for status, accepted in ((200, True), (404, False)):
            response = MagicMock(status=status)
            request = MagicMock()
            request.__aenter__ = AsyncMock(return_value=response)
            request.__aexit__ = AsyncMock(return_value=None)
            with patch.object(
                aiohttp.ClientSession, "get", return_value=request
            ) as get:
                self.assertEqual(await send_push(PUSH_URL, {"status": "up"}), accepted)
            get.assert_called_once_with(PUSH_URL, params={"status": "up"})

    async def test_send_push_failure_does_not_log_the_url(self):
        with (
            patch.object(
                aiohttp.ClientSession, "get", side_effect=aiohttp.ClientError(PUSH_URL)
            ),
            self.assertLogs(camera_ping.logger, "DEBUG") as logs,
        ):
            self.assertFalse(await send_push(PUSH_URL, {"status": "up"}))
        self.assertNotIn("s3crettoken", "\n".join(logs.output))


class TestSampler(unittest.IsolatedAsyncioTestCase):
    def app(self) -> SimpleNamespace:
        return SimpleNamespace(
            frigate_config=config({"front": {"inputs": ["rtsp://u:p@10.0.0.1/1"]}}),
            state=SimpleNamespace(),
        )

    async def run_rounds(self, app: SimpleNamespace, round_mock: AsyncMock) -> None:
        """Run the sampler until its second sleep after the start delay."""
        sleeps = AsyncMock(side_effect=[None, None, asyncio.CancelledError])
        with (
            patch.object(camera_ping, "camera_ping_round", round_mock),
            patch.object(camera_ping.asyncio, "sleep", sleeps),
        ):
            with self.assertRaises(asyncio.CancelledError):
                await camera_ping_sampler(app)
        self.assertEqual(
            [call.args[0] for call in sleeps.await_args_list],
            [
                camera_ping.START_DELAY_SECONDS,
                camera_ping.INTERVAL_SECONDS,
                camera_ping.INTERVAL_SECONDS,
            ],
        )

    async def test_reads_the_push_urls_and_warns_about_unknown_cameras(self):
        rounds = AsyncMock()
        environ = {camera_ping.PUSH_ENV: f"front={PUSH_URL} attic={PUSH_URL}"}
        with (
            patch.dict(camera_ping.os.environ, environ),
            self.assertLogs(camera_ping.logger, "WARNING") as logs,
        ):
            await self.run_rounds(self.app(), rounds)

        self.assertEqual(rounds.await_count, 2)
        self.assertEqual(
            rounds.await_args.args[2], {"front": PUSH_URL, "attic": PUSH_URL}
        )
        text = "\n".join(logs.output)
        self.assertIn("attic", text)
        self.assertNotIn("s3crettoken", text)

    async def test_a_failed_round_does_not_stop_the_sampler(self):
        rounds = AsyncMock(side_effect=[RuntimeError("boom"), {}])
        with (
            patch.dict(camera_ping.os.environ, {camera_ping.PUSH_ENV: ""}),
            self.assertLogs(camera_ping.logger, "ERROR"),
        ):
            await self.run_rounds(self.app(), rounds)
        self.assertEqual(rounds.await_count, 2)


if __name__ == "__main__":
    unittest.main()
