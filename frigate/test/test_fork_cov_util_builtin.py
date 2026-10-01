"""Behavior tests for the builtin type helpers in frigate.util.builtin."""

import math
import os
import queue
import struct
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import numpy as np
from ruamel.yaml import YAML

from frigate.const import STREAM_TYPE_SUB
from frigate.util.builtin import (
    DEFAULT_RECORD_SEGMENT_TIME,
    InferenceSpeed,
    clean_camera_user_pass,
    clear_and_unlink,
    clear_orphaned_comments,
    cosine_distance,
    cosine_similarity,
    deep_merge,
    deserialize,
    empty_and_close_queue,
    escape_config_key_segment,
    escape_special_characters,
    find_by_key,
    flatten_config_data,
    generate_color_palette,
    get_ffmpeg_arg_list,
    get_record_segment_time,
    has_non_finite_number,
    load_labels,
    process_config_query_string,
    sanitize_float,
    serialize,
    split_config_key_path,
    to_relative_box,
    update_yaml,
    update_yaml_file_bulk,
)


class TestInferenceSpeed(unittest.TestCase):
    def test_first_value_is_taken_as_is_then_smoothed(self) -> None:
        metric = SimpleNamespace(value=0.0)
        speed = InferenceSpeed(metric)

        speed.update(10.0)
        self.assertEqual(speed.current(), 10.0)

        speed.update(20.0)
        self.assertAlmostEqual(speed.current(), 11.0)
        self.assertAlmostEqual(metric.value, 11.0)


class TestDeepMerge(unittest.TestCase):
    def test_new_keys_are_added_and_inputs_untouched(self) -> None:
        first = {"a": {"b": 1}}
        second = {"c": [1, 2]}

        merged = deep_merge(first, second)

        self.assertEqual(merged, {"a": {"b": 1}, "c": [1, 2]})
        self.assertEqual(first, {"a": {"b": 1}})
        merged["c"].append(3)
        self.assertEqual(second["c"], [1, 2])

    def test_existing_scalars_kept_without_override(self) -> None:
        merged = deep_merge({"a": 1, "n": {"x": 1}}, {"a": 2, "n": {"x": 2, "y": 3}})
        self.assertEqual(merged, {"a": 1, "n": {"x": 1, "y": 3}})

    def test_override_replaces_scalars_and_nested_values(self) -> None:
        merged = deep_merge(
            {"a": 1, "n": {"x": 1}}, {"a": 2, "n": {"x": 2}}, override=True
        )
        self.assertEqual(merged, {"a": 2, "n": {"x": 2}})

    def test_lists_are_kept_replaced_or_concatenated(self) -> None:
        base = {"l": [1]}
        self.assertEqual(deep_merge(base, {"l": [2]}), {"l": [1]})
        self.assertEqual(deep_merge(base, {"l": [2]}, override=True), {"l": [2]})
        self.assertEqual(deep_merge(base, {"l": [2]}, merge_lists=True), {"l": [1, 2]})


class TestCredentialHelpers(unittest.TestCase):
    def test_clean_camera_user_pass_hides_rtsp_and_http_credentials(self) -> None:
        line = "rtsp://admin:secret@10.0.0.1/stream http://cam/?user=bob&password=pw1"
        cleaned = clean_camera_user_pass(line)

        self.assertNotIn("secret", cleaned)
        self.assertNotIn("pw1", cleaned)
        self.assertIn("rtsp://*:*@10.0.0.1/stream", cleaned)
        self.assertIn("user=*&password=*", cleaned)

    def test_escape_special_characters_encodes_password(self) -> None:
        self.assertEqual(
            escape_special_characters("rtsp://user:p@ss#1@host/stream"),
            "rtsp://user:p%40ss%231@host/stream",
        )

    def test_escape_special_characters_without_credentials(self) -> None:
        self.assertEqual(
            escape_special_characters("rtsp://host/stream"), "rtsp://host/stream"
        )

    def test_escape_special_characters_rejects_long_input(self) -> None:
        with self.assertRaises(ValueError):
            escape_special_characters("a" * 1001)


class TestFfmpegArgs(unittest.TestCase):
    def test_get_ffmpeg_arg_list(self) -> None:
        self.assertEqual(get_ffmpeg_arg_list(["-a", "b"]), ["-a", "b"])
        self.assertEqual(
            get_ffmpeg_arg_list('-f segment -metadata title="a b"'),
            ["-f", "segment", "-metadata", "title=a b"],
        )

    def _camera(self, record, record_sub=None):
        output_args = SimpleNamespace(record=record, effective_record_sub=record_sub)
        return SimpleNamespace(ffmpeg=SimpleNamespace(output_args=output_args))

    def test_segment_time_from_explicit_args(self) -> None:
        camera = self._camera("-f segment -segment_time 30 -c copy")
        self.assertEqual(get_record_segment_time(camera), 30)

    def test_segment_time_for_presets_and_missing_values(self) -> None:
        self.assertEqual(
            get_record_segment_time(self._camera("preset-record-generic")),
            DEFAULT_RECORD_SEGMENT_TIME,
        )
        self.assertEqual(
            get_record_segment_time(self._camera(["-f", "segment"])),
            DEFAULT_RECORD_SEGMENT_TIME,
        )
        self.assertEqual(
            get_record_segment_time(self._camera(["-segment_time"])),
            DEFAULT_RECORD_SEGMENT_TIME,
        )

    def test_segment_time_uses_sub_stream_args(self) -> None:
        camera = self._camera("-segment_time 30", record_sub="-segment_time 5")
        self.assertEqual(get_record_segment_time(camera, STREAM_TYPE_SUB), 5)


class TestLoadLabels(unittest.TestCase):
    def _labels_file(self, text: str) -> str:
        fd, path = tempfile.mkstemp(suffix=".txt")
        with os.fdopen(fd, "w") as f:
            f.write(text)
        self.addCleanup(os.unlink, path)
        return path

    def test_none_path_and_empty_file(self) -> None:
        self.assertEqual(load_labels(None), {})
        self.assertEqual(load_labels(self._labels_file("")), {})

    def test_indexed_file_keeps_sparse_indices(self) -> None:
        path = self._labels_file("0 person\n2 car\n")
        self.assertEqual(load_labels(path), {0: "person", 2: "car"})

    def test_plain_file_and_prefill(self) -> None:
        path = self._labels_file("person\ncar\n")
        self.assertEqual(load_labels(path), {0: "person", 1: "car"})
        self.assertEqual(
            load_labels(path, prefill=3), {0: "person", 1: "car", 2: "unknown"}
        )

    def test_indexed_false_treats_numbers_as_labels(self) -> None:
        path = self._labels_file("1 thing\n")
        self.assertEqual(load_labels(path, indexed=False), {0: "1 thing"})


class TestSmallHelpers(unittest.TestCase):
    def test_to_relative_box(self) -> None:
        self.assertEqual(
            to_relative_box(100, 200, (10, 20, 60, 120)), (0.1, 0.1, 0.5, 0.5)
        )

    def test_process_config_query_string(self) -> None:
        updates = process_config_query_string(
            {
                "a.b": ["5"],
                "a.c": ["True"],
                "mask": ["0,0,1,1"],
                "name": ["front door"],
                "multi": ["x", "y"],
            }
        )
        self.assertEqual(
            updates,
            {
                "a.b": 5,
                "a.c": True,
                "mask": "0,0,1,1",
                "name": "front door",
                "multi": ["x", "y"],
            },
        )

    def test_flatten_and_split_round_trip_dotted_keys(self) -> None:
        flat = flatten_config_data({"a": {"b.c": 1, "d": {"e": 2}}, "f": 3})
        self.assertEqual(flat, {"a.b\\.c": 1, "a.d.e": 2, "f": 3})
        self.assertEqual(split_config_key_path("a.b\\.c"), ["a", "b.c"])
        self.assertEqual(escape_config_key_segment("a\\b.c"), "a\\\\b\\.c")
        self.assertEqual(split_config_key_path("a\\\\b"), ["a\\b"])

    def test_split_trailing_backslash_is_kept(self) -> None:
        self.assertEqual(split_config_key_path("a.b\\"), ["a", "b\\"])

    def test_find_by_key_searches_nested_dicts(self) -> None:
        data = {"a": 1, "b": {"c": {"target": "found"}}, "d": {"x": 1}}
        self.assertEqual(find_by_key(data, "a"), 1)
        self.assertEqual(find_by_key(data, "target"), "found")
        self.assertIsNone(find_by_key(data, "missing"))

    def test_generate_color_palette(self) -> None:
        self.assertEqual(len(generate_color_palette(3)), 3)
        self.assertEqual(generate_color_palette(1), [(31, 119, 180)])

        palette = generate_color_palette(12)
        self.assertEqual(len(palette), 12)
        self.assertEqual(palette[:10], generate_color_palette(10))
        for color in palette[10:]:
            self.assertEqual(len(color), 3)
            self.assertTrue(all(0 <= c <= 255 for c in color))

    def test_serialize_and_deserialize(self) -> None:
        packed = serialize([1.0, 2.5])
        self.assertEqual(packed, struct.pack("2f", 1.0, 2.5))
        self.assertEqual(deserialize(packed), [1.0, 2.5])
        self.assertEqual(deserialize(serialize(np.array([[1.0], [3.0]]))), [1.0, 3.0])
        self.assertEqual(deserialize(serialize(0.5)), [0.5])
        self.assertEqual(serialize([1.0], pack=False), [1.0])

    def test_serialize_rejects_bad_input(self) -> None:
        with self.assertRaises(TypeError):
            serialize("1.0")  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            serialize(["a"])  # type: ignore[list-item]

    def test_sanitize_float(self) -> None:
        self.assertEqual(sanitize_float(float("nan")), 0.0)
        self.assertEqual(sanitize_float(float("inf")), 0.0)
        self.assertEqual(sanitize_float(1.5), 1.5)
        self.assertEqual(sanitize_float("x"), "x")

    def test_has_non_finite_number(self) -> None:
        self.assertTrue(has_non_finite_number(float("nan")))
        self.assertTrue(has_non_finite_number({"a": [1, {"b": float("-inf")}]}))
        self.assertFalse(has_non_finite_number({"a": [1, 2.0, "x"]}))
        self.assertFalse(has_non_finite_number(None))

    def test_cosine_helpers(self) -> None:
        a = np.array([1.0, 0.0])
        b = np.array([0.0, 1.0])
        self.assertAlmostEqual(cosine_distance(a, a), 0.0)
        self.assertAlmostEqual(cosine_distance(a, b), 1.0)
        self.assertAlmostEqual(cosine_similarity(a, a), 1.0)
        self.assertEqual(cosine_distance(a, np.zeros(2)), 1.0)
        self.assertTrue(
            math.isclose(cosine_similarity(a, np.array([1.0, 1.0])), math.sqrt(0.5))
        )


class TestClearAndUnlink(unittest.TestCase):
    def test_truncates_and_removes_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "f.bin"
            path.write_bytes(b"data")
            clear_and_unlink(path)
            self.assertFalse(path.exists())

    def test_missing_file_behavior(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "missing.bin"
            with self.assertRaises(FileNotFoundError):
                clear_and_unlink(path, missing_ok=False)
            self.assertFalse(path.exists())


class TestEmptyAndCloseQueue(unittest.TestCase):
    def test_drains_plain_queue(self) -> None:
        q: queue.Queue = queue.Queue()
        q.put(1)
        q.put(2)
        empty_and_close_queue(q)
        self.assertTrue(q.empty())

    def test_stops_on_unexpected_error(self) -> None:
        q = MagicMock()
        q.get.side_effect = RuntimeError("boom")
        empty_and_close_queue(q)
        q.get.assert_called_once()

    def test_closes_multiprocessing_queue(self) -> None:
        import multiprocessing

        q = multiprocessing.Queue()
        q.put("x")
        empty_and_close_queue(q)
        with self.assertRaises(ValueError):
            q.put("y")


class TestUpdateYaml(unittest.TestCase):
    def test_creates_missing_nested_dicts_and_lists(self) -> None:
        data: dict = {"a": None}
        update_yaml(data, ["a", "b"], 1)
        self.assertEqual(data, {"a": {"b": 1}})

        update_yaml(data, [("list", 1), "name"], "x")
        self.assertEqual(data["list"][1], {"name": "x"})
        self.assertEqual(len(data["list"]), 2)

    def test_extends_short_list_and_sets_indexed_values(self) -> None:
        data: dict = {"items": [1]}
        update_yaml(data, [("items", 2)], 3)
        self.assertEqual(data["items"][2], 3)
        self.assertEqual(len(data["items"]), 3)

        update_yaml(data, [("new", 0)], "v")
        self.assertEqual(data["new"], ["v"])

        data["rows"] = [{"k": 1}]
        update_yaml(data, [("rows", 2), "k"], 5)
        self.assertEqual(data["rows"][2], {"k": 5})

    def test_dict_values_are_merged_and_empty_string_deletes(self) -> None:
        data = {"a": {"x": 1}, "list": [1, 2]}
        update_yaml(data, ["a"], {"y": 2})
        self.assertEqual(data["a"], {"x": 1, "y": 2})

        update_yaml(data, ["a", "x"], "")
        self.assertEqual(data["a"], {"y": 2})

        update_yaml(data, [("list", 0)], "")
        self.assertEqual(data["list"], [2])

    def test_clear_orphaned_comments_ignores_non_empty_and_plain(self) -> None:
        collection = MagicMock()
        collection.__len__.return_value = 1
        clear_orphaned_comments(collection, None, None)
        collection.ca.items.clear.assert_not_called()
        clear_orphaned_comments({}, None, None)

    def test_bulk_update_missing_file_is_logged(self) -> None:
        with self.assertLogs("frigate.util.builtin", level="ERROR"):
            update_yaml_file_bulk("/nonexistent/dir/config.yml", {"a": 1})

    def test_bulk_update_with_list_index(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "config.yml")
            with open(path, "w") as f:
                f.write("cameras:\n  cam:\n    zones:\n      - a\n      - b\n")

            update_yaml_file_bulk(
                path, {"cameras.cam.zones.1": "c", "cameras.cam.enabled": True}
            )

            with open(path) as f:
                data = YAML().load(f)
            self.assertEqual(list(data["cameras"]["cam"]["zones"]), ["a", "c"])
            self.assertTrue(data["cameras"]["cam"]["enabled"])

    def test_bulk_update_write_failure_is_logged(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "config.yml")
            with open(path, "w") as f:
                f.write("a: 1\n")

            real_open = open

            def fake_open(file, mode="r", *args, **kwargs):
                if "w" in mode:
                    raise PermissionError("read only")
                return real_open(file, mode, *args, **kwargs)

            with (
                patch("builtins.open", side_effect=fake_open),
                self.assertLogs("frigate.util.builtin", level="ERROR"),
            ):
                update_yaml_file_bulk(path, {"a": 2})


if __name__ == "__main__":
    unittest.main()
