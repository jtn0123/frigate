"""Coverage for the frame and drawing helpers in frigate.util.image (fork D70)."""

import contextlib
import io
import subprocess as sp
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import cv2
import numpy as np

from frigate.util import image as image_util
from frigate.util.image import (
    FrameManager,
    SharedMemoryFrameManager,
    UntrackedSharedMemory,
    _format_snapshot_label,
    _get_snapshot_overlay_box_label,
    add_mask,
    area,
    calculate_16_9_crop,
    calculate_region,
    clipped,
    copy_yuv_to_position,
    create_mask,
    create_thumbnail,
    draw_box_with_label,
    draw_snapshot_bounding_boxes,
    draw_snapshot_overlay_boxes,
    draw_timestamp,
    ensure_jpeg_bytes,
    get_blank_yuv_frame,
    get_histogram,
    get_image_from_recording,
    get_image_quality_params,
    get_snapshot_bytes,
    get_yuv_crop,
    grab_cv2_contours,
    has_better_attr,
    intersection,
    intersection_over_union,
    is_better_thumbnail,
    is_label_printable,
    on_edge,
    relative_box_to_absolute,
    run_ffmpeg_snapshot,
    transliterate_to_latin,
    yuv_crop_and_resize,
    yuv_region_2_bgr,
    yuv_region_2_rgb,
    yuv_region_2_yuv,
    yuv_to_3_channel_yuv,
)


def _bgr(height: int = 20, width: int = 30) -> np.ndarray:
    return np.zeros((height, width, 3), np.uint8)


def _yuv(height: int = 40, width: int = 60, y: int = 90) -> np.ndarray:
    frame = np.full((height * 3 // 2, width), 128, np.uint8)
    frame[0:height, :] = y
    return frame


def _style(**overrides) -> SimpleNamespace:
    values = {
        "color": SimpleNamespace(red=255, green=255, blue=255),
        "format": "%Y-%m-%d %H:%M:%S",
        "effect": None,
        "thickness": 2,
        "position": "tl",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def _shm_name() -> str:
    return f"fork_d70_{uuid.uuid4().hex[:12]}"


class TestTextHelpers(unittest.TestCase):
    def test_transliterate_to_latin_strips_diacritics(self) -> None:
        self.assertEqual(transliterate_to_latin("frégate"), "fregate")

    def test_is_label_printable(self) -> None:
        self.assertTrue(is_label_printable("person 1"))
        self.assertFalse(is_label_printable("café"))

    def test_get_image_quality_params(self) -> None:
        self.assertEqual(
            get_image_quality_params("jpg", None), [int(cv2.IMWRITE_JPEG_QUALITY), 70]
        )
        self.assertEqual(
            get_image_quality_params("jpeg", 90), [int(cv2.IMWRITE_JPEG_QUALITY), 90]
        )
        self.assertEqual(
            get_image_quality_params("webp", None), [int(cv2.IMWRITE_WEBP_QUALITY), 60]
        )
        self.assertEqual(
            get_image_quality_params("webp", 5), [int(cv2.IMWRITE_WEBP_QUALITY), 5]
        )
        self.assertEqual(get_image_quality_params("png", 50), [])

    def test_format_snapshot_label_variants(self) -> None:
        self.assertEqual(_format_snapshot_label(0.87, 400, None), "87% 400")
        self.assertEqual(_format_snapshot_label(87, 400, None), "87% 400")
        self.assertEqual(_format_snapshot_label(None, None, (0, 0, 10, 5)), "0% 50")
        self.assertEqual(_format_snapshot_label(None, None, None), "0% 0")
        self.assertEqual(
            _format_snapshot_label(0.5, 10, None, estimated_speed=12.345),
            "50% 10 12.3",
        )

    def test_overlay_box_label_variants(self) -> None:
        self.assertEqual(_get_snapshot_overlay_box_label(None, (0, 0, 4, 5)), "- 20")
        self.assertEqual(_get_snapshot_overlay_box_label(0.25, (0, 0, 2, 2)), "25% 4")
        self.assertEqual(_get_snapshot_overlay_box_label(75, (0, 0, 2, 2)), "75% 4")


class TestThumbnailComparison(unittest.TestCase):
    def setUp(self) -> None:
        self.shape = (100, 200)

    def _obj(self, box, score=0.5, area_value=100, attributes=None) -> dict:
        return {
            "box": box,
            "score": score,
            "area": area_value,
            "attributes": attributes or [],
        }

    def test_on_edge(self) -> None:
        self.assertTrue(on_edge((0, 10, 20, 30), self.shape))
        self.assertTrue(on_edge((5, 0, 20, 30), self.shape))
        self.assertTrue(on_edge((5, 10, 199, 30), self.shape))
        self.assertTrue(on_edge((5, 10, 20, 99), self.shape))
        self.assertIsNone(on_edge((5, 10, 20, 30), self.shape))

    def test_has_better_attr(self) -> None:
        current = self._obj((5, 5, 50, 50))
        new = self._obj(
            (5, 5, 50, 50),
            attributes=[{"label": "face", "box": (0, 0, 9, 9)}],
        )
        self.assertTrue(has_better_attr(current, new, "face"))
        self.assertFalse(has_better_attr(new, current, "face"))
        self.assertFalse(has_better_attr(current, new, "license_plate"))

    def test_better_attribute_wins(self) -> None:
        current = self._obj((5, 5, 50, 50))
        new = self._obj(
            (5, 5, 50, 50),
            attributes=[{"label": "face", "box": (0, 0, 9, 9)}],
        )
        self.assertTrue(is_better_thumbnail(["face"], current, new, self.shape))

    def test_existing_attribute_blocks_update(self) -> None:
        current = self._obj(
            (5, 5, 50, 50),
            score=0.1,
            attributes=[{"label": "face", "box": (0, 0, 9, 9)}],
        )
        new = self._obj((5, 5, 50, 50), score=0.9, area_value=1000)
        self.assertFalse(is_better_thumbnail(["face"], current, new, self.shape))

    def test_edge_new_object_is_rejected(self) -> None:
        current = self._obj((5, 5, 50, 50))
        new = self._obj((0, 5, 50, 50), score=0.99, area_value=10_000)
        self.assertFalse(is_better_thumbnail([], current, new, self.shape))

    def test_score_and_area_rules(self) -> None:
        current = self._obj((5, 5, 50, 50), score=0.5, area_value=100)
        self.assertTrue(
            is_better_thumbnail(
                [], current, self._obj((5, 5, 50, 50), score=0.6), self.shape
            )
        )
        self.assertTrue(
            is_better_thumbnail(
                [], current, self._obj((5, 5, 50, 50), area_value=200), self.shape
            )
        )
        self.assertFalse(
            is_better_thumbnail(
                [], current, self._obj((5, 5, 50, 50), score=0.52), self.shape
            )
        )


class TestDrawTimestamp(unittest.TestCase):
    def test_positions_and_effects_draw_pixels(self) -> None:
        for position in ("tl", "tr", "bl", "br"):
            for effect in (None, "solid", "shadow"):
                with self.subTest(position=position, effect=effect):
                    frame = _bgr(120, 300)
                    draw_timestamp(
                        frame,
                        0,
                        "%H:%M:%S",
                        font_effect=effect,
                        font_color=(0, 0, 255),
                        position=position,
                    )
                    self.assertGreater(int(frame.sum()), 0)

    def test_bottom_position_leaves_top_rows_untouched(self) -> None:
        frame = _bgr(200, 300)
        draw_timestamp(frame, 0, "%H:%M", font_color=(255, 255, 255), position="br")
        self.assertEqual(int(frame[0:20].sum()), 0)
        self.assertGreater(int(frame[100:].sum()), 0)

    def test_solid_effect_paints_inverse_background(self) -> None:
        frame = _bgr(120, 300)
        draw_timestamp(
            frame, 0, "%H", font_effect="solid", font_color=(0, 0, 0), position="tl"
        )
        # the inverse of black text is a white box in the top left corner
        self.assertEqual(tuple(frame[0, 0]), (255, 255, 255))


class TestDrawBoxWithLabel(unittest.TestCase):
    def test_default_color_is_red(self) -> None:
        frame = _bgr(100, 100)
        draw_box_with_label(frame, 40, 40, 80, 80, "car", "90%")
        self.assertEqual(tuple(frame[60, 40]), (0, 0, 255))

    def test_all_positions_draw(self) -> None:
        for position in ("ul", "ur", "bl", "br"):
            with self.subTest(position=position):
                frame = _bgr(100, 120)
                draw_box_with_label(
                    frame,
                    30,
                    40,
                    80,
                    60,
                    "dog",
                    "1",
                    color=(0, 255, 0),
                    position=position,
                )
                self.assertEqual(tuple(frame[50, 30]), (0, 255, 0))

    def test_upper_label_moves_below_box_when_no_space(self) -> None:
        frame = _bgr(100, 100)
        draw_box_with_label(frame, 10, 2, 60, 30, "a", "b", color=(0, 255, 0))
        # label background is filled just below the box
        self.assertEqual(tuple(frame[33, 12]), (0, 255, 0))

    def test_upper_label_stays_above_when_space_exists(self) -> None:
        frame = _bgr(100, 100)
        draw_box_with_label(frame, 10, 50, 60, 70, "a", "b", color=(0, 255, 0))
        above = frame[20:48, 10:40]
        self.assertGreater(int(np.count_nonzero(above[:, :, 1] == 255)), 0)
        self.assertEqual(int(frame[73:].sum()), 0)

    def test_upper_label_without_room_anywhere(self) -> None:
        frame = _bgr(30, 100)
        draw_box_with_label(frame, 10, 2, 60, 28, "a", "b", color=(0, 255, 0))
        self.assertEqual(tuple(frame[2, 10]), (0, 255, 0))

    def test_bottom_label_moves_above_when_no_space_below(self) -> None:
        frame = _bgr(100, 100)
        draw_box_with_label(
            frame, 10, 50, 60, 98, "a", "b", color=(0, 255, 0), position="br"
        )
        self.assertGreater(int(frame[30:50].sum()), 0)

    def test_falls_back_when_transliteration_fails(self) -> None:
        frame = _bgr(100, 100)
        with patch.object(
            image_util, "transliterate_to_latin", side_effect=RuntimeError("boom")
        ):
            draw_box_with_label(frame, 40, 40, 80, 80, "car", "x")
        self.assertGreater(int(frame.sum()), 0)


class TestSnapshotDrawing(unittest.TestCase):
    def test_relative_box_to_absolute(self) -> None:
        self.assertIsNone(relative_box_to_absolute((100, 200), None))
        self.assertIsNone(relative_box_to_absolute((100, 200), [0.1, 0.2]))
        self.assertEqual(
            relative_box_to_absolute((100, 200), [0.1, 0.2, 0.25, 0.5]),
            (20, 20, 70, 70),
        )
        # clamps to the frame and keeps at least one pixel of size
        self.assertEqual(
            relative_box_to_absolute((100, 200), [1.5, 1.5, 1.0, 1.0]),
            (199, 99, 200, 100),
        )

    def test_bounding_boxes_noop_without_box(self) -> None:
        frame = _bgr(50, 50)
        draw_snapshot_bounding_boxes(frame, "x", None, 0.5, 10, None, (0, 255, 0))
        self.assertEqual(int(frame.sum()), 0)

    def test_bounding_boxes_draw_box_and_attributes(self) -> None:
        frame = _bgr(120, 120)
        draw_snapshot_bounding_boxes(
            frame,
            "person",
            (20, 40, 100, 110),
            0.9,
            None,
            [
                {"label": "face", "score": 0.8, "box": (60, 60, 90, 90)},
                {"label": "skip"},
            ],
            (0, 255, 0),
            estimated_speed=3.0,
        )
        self.assertEqual(tuple(frame[75, 20]), (0, 255, 0))
        self.assertEqual(tuple(frame[75, 60]), (0, 255, 0))

    def test_overlay_boxes_colors(self) -> None:
        frame = _bgr(120, 120)
        draw_snapshot_overlay_boxes(
            frame,
            [
                {"box": (20, 40, 50, 70), "color": [255, 0, 0], "score": 0.5},
                {"box": (70, 40, 100, 70), "color": "bogus", "label": "lp"},
                {"label": "no box"},
            ],
            "car",
            (0, 0, 255),
        )
        self.assertEqual(tuple(frame[55, 20]), (255, 0, 0))
        self.assertEqual(tuple(frame[55, 70]), (0, 0, 255))

    def test_overlay_boxes_none(self) -> None:
        frame = _bgr(10, 10)
        draw_snapshot_overlay_boxes(frame, None, "car", (0, 0, 255))
        self.assertEqual(int(frame.sum()), 0)


class TestGetSnapshotBytes(unittest.TestCase):
    def test_plain_jpeg(self) -> None:
        frame = _bgr(60, 80)
        data, frame_time = get_snapshot_bytes(
            frame,
            12.5,
            "jpg",
            label="car",
            box=None,
            score=None,
            area=None,
            attributes=None,
            color=(0, 0, 255),
        )
        self.assertEqual(frame_time, 12.5)
        decoded = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(decoded.shape, (60, 80, 3))
        # the source frame is never modified
        self.assertEqual(int(frame.sum()), 0)

    def test_bounding_box_crop_height_and_timestamp(self) -> None:
        frame = _bgr(400, 600)
        data, _ = get_snapshot_bytes(
            frame,
            0.0,
            "png",
            timestamp=True,
            bounding_box=True,
            crop=True,
            height=100,
            label="car",
            box=(100, 100, 200, 200),
            score=0.9,
            area=None,
            attributes=[{"label": "lp", "score": 0.5, "box": (120, 150, 160, 170)}],
            color=(0, 255, 0),
            overlay_boxes=[{"box": (300, 300, 350, 350)}],
            timestamp_style=_style(position="bl"),
        )
        decoded = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        # cropped to a 330 px square region and resized to 100 px tall
        self.assertEqual(decoded.shape, (100, 100, 3))
        self.assertGreater(int(decoded.sum()), 0)

    def test_crop_uses_single_overlay_box_when_box_missing(self) -> None:
        frame = _bgr(400, 600)
        data, _ = get_snapshot_bytes(
            frame,
            0.0,
            "png",
            bounding_box=True,
            crop=True,
            label="lp",
            box=None,
            score=None,
            area=None,
            attributes=None,
            color=(0, 255, 0),
            overlay_boxes=[{"box": (10, 10, 50, 50), "score": 0.4}],
        )
        decoded = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(decoded.shape, (300, 300, 3))

    def test_timestamp_requires_style(self) -> None:
        frame = _bgr(60, 80)
        data, _ = get_snapshot_bytes(
            frame,
            0.0,
            "png",
            timestamp=True,
            label="x",
            box=None,
            score=None,
            area=None,
            attributes=None,
            color=(0, 0, 0),
        )
        decoded = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(int(decoded.sum()), 0)

    def test_encode_failure_returns_none(self) -> None:
        with patch.object(image_util.cv2, "imencode", return_value=(False, None)):
            data, frame_time = get_snapshot_bytes(
                _bgr(),
                4.0,
                "jpg",
                label="x",
                box=None,
                score=None,
                area=None,
                attributes=None,
                color=(0, 0, 0),
            )
        self.assertIsNone(data)
        self.assertEqual(frame_time, 4.0)


class TestGeometry(unittest.TestCase):
    def test_grab_cv2_contours(self) -> None:
        self.assertEqual(grab_cv2_contours(("a", "b")), "a")
        self.assertEqual(grab_cv2_contours(("a", "b", "c")), "b")
        self.assertIsNone(grab_cv2_contours(("a",)))

    def test_calculate_region_clamps(self) -> None:
        self.assertEqual(calculate_region((100, 100), 0, 0, 10, 10, 20), (0, 0, 20, 20))
        self.assertEqual(
            calculate_region((100, 100), 90, 90, 99, 99, 20), (80, 80, 100, 100)
        )
        # model size larger than the frame clamps offsets to zero
        self.assertEqual(calculate_region((50, 50), 40, 40, 49, 49, 64), (0, 0, 64, 64))
        self.assertEqual(
            calculate_region((200, 200), 80, 80, 120, 100, 20), (60, 50, 140, 130)
        )

    def test_calculate_16_9_crop(self) -> None:
        self.assertEqual(
            calculate_16_9_crop((720, 1280), 100, 100, 300, 200),
            (24, 50, 376, 250),
        )
        # a wide box keeps its width and derives a 16:9 height
        self.assertEqual(
            calculate_16_9_crop((720, 1280), 100, 100, 500, 200),
            (50, 10, 550, 290),
        )
        # small box is grown to the minimum size and clamped to the origin
        self.assertEqual(
            calculate_16_9_crop((720, 1280), 0, 0, 20, 20), (0, 0, 352, 200)
        )
        # clamped to the bottom right corner
        self.assertEqual(
            calculate_16_9_crop((720, 1280), 1200, 650, 1279, 719),
            (928, 520, 1280, 720),
        )

    def test_calculate_16_9_crop_rejects_extreme_shapes(self) -> None:
        # very wide frame with a very wide box
        self.assertIsNone(calculate_16_9_crop((100, 1000), 0, 0, 900, 10))
        # tall box needs more height than 16:9 by width allows
        self.assertEqual(
            calculate_16_9_crop((720, 1280), 100, 100, 150, 600),
            (0, 37, 1108, 662),
        )

    def test_intersection_and_iou(self) -> None:
        self.assertIsNone(intersection((0, 0, 5, 5), (10, 10, 20, 20)))
        self.assertEqual(intersection((0, 0, 10, 10), (5, 5, 20, 20)), (5, 5, 10, 10))
        self.assertEqual(area((0, 0, 9, 9)), 100)
        self.assertEqual(intersection_over_union((0, 0, 5, 5), (10, 10, 20, 20)), 0.0)
        self.assertEqual(intersection_over_union((0, 0, 9, 9), (0, 0, 9, 9)), 1.0)
        self.assertAlmostEqual(
            intersection_over_union((0, 0, 9, 9), (5, 0, 14, 9)), 50 / 150
        )
        # an inverted box intersects with zero area
        self.assertEqual(intersection_over_union((5, 0, 3, 10), (0, 0, 10, 10)), 0.0)

    def test_clipped(self) -> None:
        shape = (100, 100)
        self.assertFalse(clipped((0, 0, (0, 0, 50, 50), 0, 0, (0, 0, 100, 100)), shape))
        self.assertTrue(
            clipped((0, 0, (12, 30, 40, 40), 0, 0, (10, 10, 60, 60)), shape)
        )
        self.assertTrue(
            clipped((0, 0, (30, 12, 40, 40), 0, 0, (10, 10, 60, 60)), shape)
        )
        self.assertTrue(
            clipped((0, 0, (30, 30, 58, 40), 0, 0, (10, 10, 60, 60)), shape)
        )
        self.assertTrue(
            clipped((0, 0, (30, 30, 40, 58), 0, 0, (10, 10, 60, 60)), shape)
        )
        self.assertFalse(
            clipped((0, 0, (30, 30, 40, 40), 0, 0, (10, 10, 60, 60)), shape)
        )


class TestYuvHelpers(unittest.TestCase):
    def test_get_yuv_crop_layout(self) -> None:
        y, u1, u2, v1, v2 = get_yuv_crop((60, 40), (8, 4, 16, 12))
        self.assertEqual(y, (8, 4, 16, 12))
        self.assertEqual(u1, (4, 41, 8, 43))
        self.assertEqual(u2, (24, 41, 28, 43))
        self.assertEqual(v1, (4, 51, 8, 53))
        self.assertEqual(v2, (24, 51, 28, 53))

    def test_yuv_crop_and_resize_inside_frame(self) -> None:
        frame = _yuv(40, 60, y=200)
        cropped = yuv_crop_and_resize(frame, (0, 0, 20, 20))
        self.assertEqual(cropped.shape, (30, 20))
        self.assertTrue(np.all(cropped[0:20, 0:20] == 200))
        self.assertTrue(np.all(cropped[20:] == 128))

    def test_yuv_crop_and_resize_pads_outside_frame(self) -> None:
        frame = _yuv(40, 60, y=200)
        cropped = yuv_crop_and_resize(frame, (-8, -8, 24, 24))
        self.assertEqual(cropped.shape, (48, 32))
        # padding outside the source frame stays black luma
        self.assertEqual(int(cropped[0, 0]), 16)
        self.assertEqual(int(cropped[10, 10]), 200)

    def test_yuv_to_3_channel_yuv(self) -> None:
        frame = _yuv(4, 4, y=50)
        frame[4, 0:2] = 10  # first u row
        out = yuv_to_3_channel_yuv(frame)
        self.assertEqual(out.shape, (4, 4, 3))
        self.assertTrue(np.all(out[:, :, 0] == 50))
        self.assertEqual(int(out[0, 0, 1]), 10)
        self.assertEqual(int(out[1, 1, 1]), 10)
        self.assertTrue(np.all(out[:, :, 2] == 128))

    def test_yuv_region_conversions(self) -> None:
        frame = _yuv(40, 60, y=200)
        region = (0, 0, 20, 20)
        self.assertEqual(yuv_region_2_yuv(frame, region).shape, (20, 20, 3))
        rgb = yuv_region_2_rgb(frame, region)
        bgr = yuv_region_2_bgr(frame, region)
        self.assertEqual(rgb.shape, (20, 20, 3))
        self.assertEqual(bgr.shape, (20, 20, 3))
        self.assertGreater(int(rgb[0, 0, 0]), 150)

    def test_yuv_region_conversions_reraise(self) -> None:
        frame = _yuv(40, 60)
        # a region narrower than tall makes the copy shapes disagree
        bad_region = (0, 0, 40, 8)
        for func in (yuv_region_2_yuv, yuv_region_2_rgb, yuv_region_2_bgr):
            with self.subTest(func=func.__name__):
                buffer = io.StringIO()
                with contextlib.redirect_stdout(buffer), self.assertRaises(ValueError):
                    func(frame, bad_region)
                self.assertIn("region: (0, 0, 40, 8)", buffer.getvalue())

    def test_get_blank_yuv_frame(self) -> None:
        frame = get_blank_yuv_frame(8, 8)
        self.assertEqual(frame.shape, (12, 8))
        self.assertTrue(np.all(frame[0:8] == 0))
        self.assertTrue(np.all(frame[8:12] == 128))

    def test_copy_yuv_to_position_letterboxes_wide_source(self) -> None:
        dest = np.zeros((48, 64), np.uint8)
        source = _yuv(8, 32, y=200)
        source_dims = {
            "y": (0, 0, 32, 8),
            "u1": (0, 8, 16, 10),
            "u2": (16, 8, 32, 10),
            "v1": (0, 10, 16, 12),
            "v2": (16, 10, 32, 12),
        }
        copy_yuv_to_position(dest, (0, 0), (32, 32), source, source_dims)
        # source is wider than the slot, so the width is filled
        self.assertEqual(int(dest[10, 0]), 200)
        self.assertEqual(int(dest[10, 31]), 200)
        self.assertEqual(int(dest[0, 0]), 16)

    def test_copy_yuv_to_position_pillarboxes_tall_source(self) -> None:
        dest = np.zeros((48, 64), np.uint8)
        source = _yuv(32, 8, y=200)
        source_dims = {
            "y": (0, 0, 8, 32),
            "u1": (0, 32, 4, 36),
            "u2": (4, 32, 8, 36),
            "v1": (0, 40, 4, 44),
            "v2": (4, 40, 8, 44),
        }
        copy_yuv_to_position(dest, (0, 0), (32, 32), source, source_dims)
        self.assertEqual(int(dest[0, 12]), 200)
        self.assertEqual(int(dest[0, 0]), 16)


class _DelegatingFrameManager(FrameManager):
    """Concrete manager that calls the abstract bodies to exercise them."""

    def create(self, name, size):
        return super().create(name, size)

    def write(self, name):
        return super().write(name)

    def get(self, name, timeout_ms=0):
        return super().get(name, timeout_ms)

    def close(self, name):
        return super().close(name)

    def delete(self, name):
        return super().delete(name)

    def cleanup(self):
        return super().cleanup()


class TestFrameManagers(unittest.TestCase):
    def test_abstract_frame_manager(self) -> None:
        with self.assertRaises(TypeError):
            FrameManager()  # type: ignore[abstract]
        manager = _DelegatingFrameManager()
        self.assertIsNone(manager.create("a", 1))
        self.assertIsNone(manager.write("a"))
        self.assertIsNone(manager.get("a"))
        self.assertIsNone(manager.close("a"))
        self.assertIsNone(manager.delete("a"))
        self.assertIsNone(manager.cleanup())

    def test_untracked_shared_memory_round_trip(self) -> None:
        name = _shm_name()
        shm = UntrackedSharedMemory(name=name, create=True, size=16)
        try:
            shm.buf[0] = 7
            other = UntrackedSharedMemory(name=name)
            self.assertEqual(other.buf[0], 7)
            other.close()
        finally:
            shm.close()
            shm.unlink()
        with self.assertRaises(FileNotFoundError):
            UntrackedSharedMemory(name=name)

    def test_untracked_shared_memory_with_tracking(self) -> None:
        name = _shm_name()
        with (
            patch.object(image_util._mprt, "register") as register,
            patch.object(image_util._mprt, "unregister") as unregister,
        ):
            shm = UntrackedSharedMemory(name=name, create=True, size=8, track=True)
            shm.close()
            shm.unlink()
        self.assertTrue(register.called)
        unregister.assert_called_once()

    def test_untracked_register_is_noop(self) -> None:
        self.assertIsNone(UntrackedSharedMemory._UntrackedSharedMemory__tmp_register())

    def test_shared_memory_manager_lifecycle(self) -> None:
        manager = SharedMemoryFrameManager()
        name = _shm_name()
        try:
            buf = manager.create(name, 6)
            buf[:] = bytes([1, 2, 3, 4, 5, 6])
            # creating again reuses the existing segment
            manager.create(name, 6)
            arr = manager.get(name, (2, 3))
            self.assertEqual(arr.tolist(), [[1, 2, 3], [4, 5, 6]])
            self.assertIs(manager.write(name), manager.shm_store[name].buf)

            manager.close(name)
            self.assertNotIn(name, manager.shm_store)
            manager.close(name)

            # get reopens and caches a segment of the right size
            self.assertEqual(manager.get(name, (6,)).tolist(), [1, 2, 3, 4, 5, 6])
            self.assertIn(name, manager.shm_store)
            manager.close(name)

            # write reopens a segment that is not cached
            self.assertEqual(manager.write(name)[0], 1)
            manager.delete(name)
            self.assertNotIn(name, manager.shm_store)
            self.assertIsNone(manager.write(name))
            self.assertIsNone(manager.get(name, (2, 3)))
        finally:
            manager.delete(name)

    def test_delete_uncached_segment(self) -> None:
        name = _shm_name()
        UntrackedSharedMemory(name=name, create=True, size=4).close()
        manager = SharedMemoryFrameManager()
        manager.delete(name)
        with self.assertRaises(FileNotFoundError):
            UntrackedSharedMemory(name=name)
        # deleting a missing segment is a no-op
        manager.delete(name)

    def test_delete_and_cleanup_tolerate_unlinked_segments(self) -> None:
        manager = SharedMemoryFrameManager()
        missing = MagicMock()
        missing.unlink.side_effect = FileNotFoundError
        manager.shm_store["a"] = missing
        manager.delete("a")
        self.assertNotIn("a", manager.shm_store)

        first = MagicMock()
        second = MagicMock()
        second.unlink.side_effect = FileNotFoundError
        manager.shm_store.update({"b": first, "c": second})
        manager.cleanup()
        first.close.assert_called_once()
        first.unlink.assert_called_once()
        second.close.assert_called_once()

    def test_get_ignores_close_errors_on_stale_segments(self) -> None:
        manager = SharedMemoryFrameManager()
        stale = MagicMock(size=4)
        stale.close.side_effect = OSError("busy")
        reopened = MagicMock(size=8)
        reopened.close.side_effect = OSError("busy")
        manager.shm_store["cam"] = stale
        with patch.object(image_util, "UntrackedSharedMemory", return_value=reopened):
            self.assertIsNone(manager.get("cam", (3, 3)))
        self.assertNotIn("cam", manager.shm_store)
        stale.close.assert_called_once()
        reopened.close.assert_called_once()


class TestMasks(unittest.TestCase):
    def test_create_mask_variants(self) -> None:
        self.assertTrue(np.all(create_mask((10, 10), None) == 255))
        single = create_mask((10, 10), "0,0,0.5,0,0.5,0.5,0,0.5")
        self.assertEqual(int(single[2, 2]), 0)
        self.assertEqual(int(single[8, 8]), 255)
        multi = create_mask(
            (10, 10), ["0,0,0.3,0,0.3,0.3,0,0.3", "0.6,0.6,0.9,0.6,0.9,0.9,0.6,0.9"]
        )
        self.assertEqual(int(multi[1, 1]), 0)
        self.assertEqual(int(multi[7, 7]), 0)
        self.assertEqual(int(multi[5, 5]), 255)

    def test_add_mask_rejects_absolute_coordinates(self) -> None:
        with self.assertRaises(Exception) as ctx:
            add_mask("0,0,100,0,100,100", np.zeros((10, 10), np.uint8))
        self.assertIn("relative coordinates", str(ctx.exception))


class TestFfmpegSnapshot(unittest.TestCase):
    def setUp(self) -> None:
        self.ffmpeg = SimpleNamespace(ffmpeg_path="/usr/bin/ffmpeg")

    def test_success_builds_full_command(self) -> None:
        result = SimpleNamespace(returncode=0, stdout=b"jpeg", stderr=b"")
        with patch.object(image_util.sp, "run", return_value=result) as run:
            data, err = run_ffmpeg_snapshot(
                self.ffmpeg, "in.mp4", "mjpeg", seek_time=1.5, height=240, timeout=5
            )
        self.assertEqual((data, err), (b"jpeg", ""))
        cmd = run.call_args.args[0]
        self.assertEqual(cmd[0], "/usr/bin/ffmpeg")
        self.assertIn("00:00:1.5", cmd)
        self.assertEqual(cmd[-5:-3], ["-vf", "scale=-1:240"])
        self.assertEqual(cmd[-1], "-")
        self.assertEqual(run.call_args.kwargs["timeout"], 5)

    def test_failure_reports_stderr(self) -> None:
        result = SimpleNamespace(returncode=1, stdout=b"", stderr=b"bad input")
        with patch.object(image_util.sp, "run", return_value=result) as run:
            data, err = run_ffmpeg_snapshot(self.ffmpeg, "in.mp4", "png")
        self.assertEqual((data, err), (None, "bad input"))
        cmd = run.call_args.args[0]
        self.assertNotIn("-ss", cmd)
        self.assertNotIn("-vf", cmd)

    def test_failure_without_stderr(self) -> None:
        result = SimpleNamespace(returncode=0, stdout=b"", stderr=None)
        with patch.object(image_util.sp, "run", return_value=result):
            self.assertEqual(
                run_ffmpeg_snapshot(self.ffmpeg, "in.mp4", "png"),
                (None, "ffmpeg failed"),
            )

    def test_timeout(self) -> None:
        with patch.object(
            image_util.sp, "run", side_effect=sp.TimeoutExpired("ffmpeg", 1)
        ):
            self.assertEqual(
                run_ffmpeg_snapshot(self.ffmpeg, "in.mp4", "png", timeout=1),
                (None, "timeout"),
            )

    def test_get_image_from_recording(self) -> None:
        result = SimpleNamespace(returncode=0, stdout=b"img", stderr=b"")
        with patch.object(image_util.sp, "run", return_value=result) as run:
            self.assertEqual(
                get_image_from_recording(self.ffmpeg, "rec.mp4", 2.0, "mjpeg", 100),
                b"img",
            )
        cmd = run.call_args.args[0]
        self.assertIn("00:00:2.0", cmd)
        self.assertIn("scale=-1:100", cmd)


class TestEncodingHelpers(unittest.TestCase):
    def test_get_histogram_is_normalized(self) -> None:
        hist = get_histogram(_yuv(40, 60), 0, 0, 20, 20)
        self.assertEqual(hist.shape, (512,))
        self.assertAlmostEqual(float(np.linalg.norm(hist)), 1.0, places=5)

    def test_create_thumbnail(self) -> None:
        data = create_thumbnail(_yuv(120, 160, y=150), (10, 10, 50, 50), height=60)
        self.assertEqual(data[:2], b"\xff\xd8")
        decoded = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(decoded.shape[0], 60)

    def test_create_thumbnail_encode_failure(self) -> None:
        with patch.object(image_util.cv2, "imencode", return_value=(False, None)):
            self.assertIsNone(
                create_thumbnail(_yuv(120, 160), (10, 10, 50, 50), height=60)
            )

    def test_ensure_jpeg_bytes_converts_png(self) -> None:
        _, png = cv2.imencode(".png", _bgr(8, 8))
        out = ensure_jpeg_bytes(png.tobytes())
        self.assertEqual(out[:2], b"\xff\xd8")

    def test_ensure_jpeg_bytes_passthrough_cases(self) -> None:
        self.assertEqual(ensure_jpeg_bytes(b"not an image"), b"not an image")
        _, png = cv2.imencode(".png", _bgr(8, 8))
        raw = png.tobytes()
        with patch.object(image_util.cv2, "imencode", return_value=(False, None)):
            self.assertEqual(ensure_jpeg_bytes(raw), raw)
        with (
            patch.object(image_util.cv2, "imdecode", side_effect=cv2.error("x")),
            self.assertLogs(image_util.logger, level="WARNING"),
        ):
            self.assertEqual(ensure_jpeg_bytes(raw), raw)


if __name__ == "__main__":
    unittest.main()
