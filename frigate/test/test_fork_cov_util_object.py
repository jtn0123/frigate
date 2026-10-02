"""Behavior tests for the region and detection helpers in frigate.util.object."""

import datetime
import unittest
from types import SimpleNamespace

import numpy as np
from peewee import SqliteDatabase

from frigate.detectors.detector_config import PixelFormatEnum
from frigate.models import Event, Regions, Timeline
from frigate.util.image import calculate_region
from frigate.util.object import (
    GRID_SIZE,
    box_inside,
    box_overlaps,
    create_empty_regions_grid,
    create_tensor_input,
    get_camera_regions_grid,
    get_cluster_boundary,
    get_cluster_candidates,
    get_cluster_region,
    get_cluster_region_from_grid,
    get_min_region_size,
    get_region_from_grid,
    get_startup_regions,
    inside_any,
    intersects_any,
    is_object_filtered,
    median_of_boxes,
    reduce_boxes,
    reduce_detections,
)

FRAME_SHAPE = (720, 1280)


def _grid_with_cell(x: int, y: int, mean: float, std_dev: float) -> list:
    grid = create_empty_regions_grid()
    grid[x][y] = {
        "sizes": [mean],
        "x": x,
        "y": y,
        "mean": mean,
        "std_dev": std_dev,
    }
    return grid


class TestCameraRegionsGrid(unittest.TestCase):
    def setUp(self) -> None:
        self.db = SqliteDatabase(":memory:")
        self.models = [Event, Regions, Timeline]
        self.ctx = self.db.bind_ctx(self.models)
        self.ctx.__enter__()
        self.db.create_tables(self.models)
        self.detect = SimpleNamespace(width=1280, height=720)

    def tearDown(self) -> None:
        self.db.drop_tables(self.models)
        self.ctx.__exit__(None, None, None)
        self.db.close()

    def _add_event(
        self, event_id: str, start_time: float, false_positive: bool = False
    ) -> None:
        Event.insert(
            id=event_id,
            label="person",
            camera="front",
            start_time=start_time,
            end_time=start_time + 1,
            top_score=0.9,
            score=0.9,
            false_positive=false_positive,
            zones=[],
            thumbnail="",
            region=[],
            box=[],
            area=0,
            plus_id="",
            model_hash="",
            detector_type="",
            model_type="",
            data={},
        ).execute()

    def _add_timeline(self, event_id: str, source: str, box: list[float]):
        Timeline.insert(
            timestamp=datetime.datetime.now().timestamp(),
            camera="front",
            source=source,
            source_id=event_id,
            class_type="visible",
            data={"box": box},
        ).execute()

    def test_without_events_returns_empty_grid_and_skips_db(self) -> None:
        grid = get_camera_regions_grid("front", self.detect, 320)

        self.assertEqual(len(grid), GRID_SIZE)
        self.assertTrue(all(cell == {"sizes": []} for row in grid for cell in row))
        self.assertEqual(Regions.select().count(), 0)

    def test_learns_region_sizes_and_persists_grid(self) -> None:
        self._add_event("e1", 100.0)
        self._add_event("e2", 101.0, false_positive=True)
        box = [0.1, 0.1, 0.2, 0.2]
        self._add_timeline("e1", "tracked_object", box)
        self._add_timeline("e1", "tracked_object", box)
        self._add_timeline("e1", "audio", [0.8, 0.8, 0.1, 0.1])
        self._add_timeline("e2", "tracked_object", [0.8, 0.8, 0.1, 0.1])

        grid = get_camera_regions_grid("front", self.detect, 320)

        region = calculate_region(FRAME_SHAPE, 128, 72, 384, 216, 320, 1.35)
        expected = (region[2] - region[0]) / 1280
        cell = grid[1][1]
        self.assertEqual(cell["sizes"], [expected, expected])
        self.assertAlmostEqual(cell["mean"], expected)
        self.assertEqual(cell["std_dev"], 0)
        self.assertEqual((cell["x"], cell["y"]), (1, 1))
        # the audio entry and the false positive event are ignored
        populated = [c for row in grid for c in row if c["sizes"]]
        self.assertEqual(len(populated), 1)

        stored = Regions.get(Regions.camera == "front")
        self.assertEqual(stored.grid[1][1]["sizes"], [expected, expected])

        # a second call finds no newer events and returns the stored grid
        again = get_camera_regions_grid("front", self.detect, 320)
        self.assertEqual(again[1][1]["sizes"], [expected, expected])
        self.assertEqual(Regions.select().count(), 1)


class TestRegionFromGrid(unittest.TestCase):
    cluster = [100, 100, 150, 150]

    def test_empty_cell_uses_calculated_region(self) -> None:
        grid = create_empty_regions_grid()
        self.assertEqual(
            get_region_from_grid(FRAME_SHAPE, self.cluster, 100, grid),
            (75, 75, 175, 175),
        )

    def test_region_within_expected_size_is_kept(self) -> None:
        grid = _grid_with_cell(0, 1, mean=100 / 1280, std_dev=0.01)
        self.assertEqual(
            get_region_from_grid(FRAME_SHAPE, self.cluster, 100, grid),
            (75, 75, 175, 175),
        )

    def test_region_larger_than_expected_is_kept(self) -> None:
        grid = _grid_with_cell(0, 1, mean=0.01, std_dev=0.001)
        self.assertEqual(
            get_region_from_grid(FRAME_SHAPE, self.cluster, 100, grid),
            (75, 75, 175, 175),
        )

    def test_small_region_grows_to_learned_size(self) -> None:
        grid = _grid_with_cell(0, 1, mean=0.25, std_dev=0.01)
        self.assertEqual(
            get_region_from_grid(FRAME_SHAPE, self.cluster, 100, grid),
            (0, 0, 568, 568),
        )

    def test_cluster_region_from_grid_uses_bounding_box(self) -> None:
        boxes = [(100, 100, 120, 120), (130, 140, 150, 150), (900, 600, 950, 650)]
        grid = create_empty_regions_grid()
        self.assertEqual(
            get_cluster_region_from_grid(FRAME_SHAPE, 100, [0, 1], boxes, grid),
            calculate_region(FRAME_SHAPE, 100, 100, 150, 150, 100),
        )


class TestObjectFilter(unittest.TestCase):
    def _filters(self, mask=None):
        return {
            "person": SimpleNamespace(
                min_area=100,
                max_area=10000,
                min_score=0.5,
                min_ratio=0.2,
                max_ratio=5.0,
                rasterized_mask=mask,
            )
        }

    def _obj(self, score=0.8, area=1000, ratio=1.0, box=(0, 0, 10, 10)):
        return ("person", score, box, area, ratio)

    def test_untracked_label_is_filtered(self) -> None:
        self.assertTrue(is_object_filtered(("cat", 0.9, (0, 0, 1, 1), 5, 1), [], {}))

    def test_label_without_filters_passes(self) -> None:
        self.assertFalse(is_object_filtered(self._obj(), ["person"], {}))

    def test_each_threshold_filters(self) -> None:
        filters = self._filters()
        tracked = ["person"]
        self.assertTrue(is_object_filtered(self._obj(area=50), tracked, filters))
        self.assertTrue(is_object_filtered(self._obj(area=20000), tracked, filters))
        self.assertTrue(is_object_filtered(self._obj(score=0.1), tracked, filters))
        self.assertTrue(is_object_filtered(self._obj(ratio=0.1), tracked, filters))
        self.assertTrue(is_object_filtered(self._obj(ratio=9.0), tracked, filters))
        self.assertFalse(is_object_filtered(self._obj(), tracked, filters))

    def test_mask_filters_by_bottom_center(self) -> None:
        mask = np.full((20, 20), 255, np.uint8)
        mask[10, 5] = 0
        filters = self._filters(mask)
        tracked = ["person"]
        self.assertTrue(
            is_object_filtered(self._obj(box=(0, 0, 10, 10)), tracked, filters)
        )
        self.assertFalse(
            is_object_filtered(self._obj(box=(10, 0, 20, 10)), tracked, filters)
        )
        # coordinates past the mask edge are clamped instead of raising
        self.assertFalse(
            is_object_filtered(self._obj(box=(30, 0, 40, 50)), tracked, filters)
        )


class TestModelInput(unittest.TestCase):
    def test_min_region_size(self) -> None:
        def size(height: int, width: int) -> int:
            return get_min_region_size(SimpleNamespace(height=height, width=width))

        self.assertEqual(size(300, 300), 300)
        self.assertEqual(size(302, 200), 304)
        self.assertEqual(size(640, 640), 320)

    def test_create_tensor_input_for_each_pixel_format(self) -> None:
        frame = np.full((720, 640), 128, np.uint8)
        region = (0, 0, 320, 320)

        for pixel_format in (
            PixelFormatEnum.rgb,
            PixelFormatEnum.bgr,
            PixelFormatEnum.yuv,
        ):
            for model_size in (320, 160):
                model = SimpleNamespace(
                    input_pixel_format=pixel_format,
                    width=model_size,
                    height=model_size,
                )
                with self.subTest(pixel_format=pixel_format, size=model_size):
                    tensor = create_tensor_input(frame, model, region)
                    self.assertEqual(tensor.shape, (1, model_size, model_size, 3))


class TestBoxHelpers(unittest.TestCase):
    def test_overlap_and_inside(self) -> None:
        self.assertTrue(box_overlaps((0, 0, 10, 10), (5, 5, 15, 15)))
        self.assertFalse(box_overlaps((0, 0, 10, 10), (11, 0, 20, 10)))
        self.assertTrue(box_inside((0, 0, 10, 10), (2, 2, 8, 8)))
        self.assertFalse(box_inside((0, 0, 10, 10), (2, 2, 11, 8)))

    def test_any_helpers(self) -> None:
        boxes = [(0, 0, 10, 10), (50, 50, 60, 60)]
        self.assertTrue(intersects_any((55, 55, 70, 70), boxes))
        self.assertFalse(intersects_any((20, 20, 30, 30), boxes))
        self.assertTrue(inside_any((52, 52, 58, 58), boxes))
        self.assertFalse(inside_any((5, 5, 15, 15), boxes))

    def test_median_of_boxes_by_area(self) -> None:
        boxes = [(0, 0, 10, 10), (0, 0, 1, 1), (0, 0, 5, 5)]
        self.assertEqual(median_of_boxes(boxes), (0, 0, 5, 5))

    def test_reduce_boxes_with_threshold(self) -> None:
        boxes = [(0, 0, 10, 10), (1, 1, 11, 11), (100, 100, 110, 110)]
        self.assertEqual(reduce_boxes(boxes), [(0, 0, 11, 11), (100, 100, 110, 110)])
        self.assertEqual(len(reduce_boxes(boxes, iou_threshold=0.9)), 3)


class TestClusters(unittest.TestCase):
    def test_cluster_boundary(self) -> None:
        self.assertEqual(
            get_cluster_boundary([100, 100, 120, 120], 320), [-199, -199, 419, 419]
        )

    def test_nearby_boxes_cluster_and_far_boxes_do_not(self) -> None:
        boxes = [(100, 100, 120, 120), (130, 130, 150, 150), (1000, 600, 1020, 620)]
        candidates = sorted(get_cluster_candidates(FRAME_SHAPE, 320, boxes))
        self.assertEqual(candidates, [[0, 1], [2]])

    def test_large_boxes_cluster_into_a_bigger_region(self) -> None:
        boxes = [(100, 100, 300, 300), (310, 100, 500, 300)]
        self.assertEqual(get_cluster_candidates(FRAME_SHAPE, 320, boxes), [[0, 1]])

    def test_tiny_box_is_not_clustered_with_large_one(self) -> None:
        boxes = [(0, 0, 400, 400), (600, 600, 605, 605)]
        candidates = sorted(get_cluster_candidates(FRAME_SHAPE, 320, boxes))
        self.assertEqual(candidates, [[0], [1]])

    def test_cluster_region(self) -> None:
        boxes = [(100, 100, 120, 120), (130, 140, 150, 150)]
        self.assertEqual(
            get_cluster_region(FRAME_SHAPE, 320, [0, 1], boxes),
            calculate_region(FRAME_SHAPE, 100, 100, 150, 150, 320, multiplier=1.35),
        )

    def test_startup_regions_from_popular_cells(self) -> None:
        grid = _grid_with_cell(1, 2, mean=0.25, std_dev=0.01)
        self.assertEqual(
            get_startup_regions(FRAME_SHAPE, 320, grid), [(80, 65, 400, 385)]
        )
        self.assertEqual(
            get_startup_regions(FRAME_SHAPE, 320, create_empty_regions_grid()), []
        )


class TestReduceDetections(unittest.TestCase):
    def test_nms_and_consolidation(self) -> None:
        full = (0, 0, 1280, 720)
        person_a = ("person", 0.9, (100, 100, 200, 300), 20000, 0.5, full)
        person_b = ("person", 0.8, (105, 105, 205, 305), 20000, 0.5, full)
        big_car = ("car", 0.9, (0, 0, 400, 400), 160000, 1.0, full)
        small_car = ("car", 0.85, (200, 200, 390, 390), 36100, 1.0, full)
        # clipped on the region edge, so its confidence is lowered for NMS
        dog = ("dog", 0.95, (12, 400, 60, 450), 2400, 1.0, (10, 300, 500, 700))

        result = reduce_detections(
            FRAME_SHAPE, [person_a, person_b, big_car, small_car, dog]
        )

        self.assertIn(person_a, result)
        self.assertNotIn(person_b, result)
        self.assertIn(big_car, result)
        self.assertNotIn(small_car, result)
        self.assertIn(dog, result)
        self.assertEqual(len(result), 3)

    def test_distant_same_label_detections_are_kept(self) -> None:
        full = (0, 0, 1280, 720)
        car_a = ("car", 0.9, (0, 0, 100, 100), 10000, 1.0, full)
        car_b = ("car", 0.9, (500, 500, 600, 600), 10000, 1.0, full)
        tiny = ("car", 0.9, (50, 50, 55, 55), 25, 1.0, full)
        result = reduce_detections(FRAME_SHAPE, [car_a, car_b, tiny])
        # the tiny car is under 5% of the larger box, so it is not consolidated
        self.assertEqual(sorted(result), sorted([car_a, car_b, tiny]))


if __name__ == "__main__":
    unittest.main()
