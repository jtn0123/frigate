"""Regression checks for storage units and retained event metric semantics."""

import unittest

from frigate.stats.prometheus import CustomCollector


class ExporterUnitsTests(unittest.TestCase):
    def test_storage_uses_binary_mebibytes(self):
        collector = CustomCollector(None)
        collector.complete_stats = {
            "service": {
                "storage": {
                    "recordings": {
                        "free": 1024,
                        "used": 2048,
                        "total": 3072,
                        "mount_type": "nfs",
                    }
                }
            }
        }
        samples = {
            sample.name: sample.value
            for metric in collector.collect()
            for sample in metric.samples
        }
        self.assertEqual(samples["frigate_storage_free_bytes"], 1024**3)
        self.assertEqual(samples["frigate_storage_used_bytes"], 2 * 1024**3)
        self.assertEqual(samples["frigate_storage_total_bytes"], 3 * 1024**3)

    def test_retention_can_decrease_without_counter_reset_semantics(self):
        collector = CustomCollector(None)
        for count in (10, 3):
            collector.all_events = [
                {"camera": "doorbell", "label": "person", "Count": count}
            ]
            metrics = list(collector.collect())
            metric = next(
                m for m in metrics if m.name == "frigate_camera_events_retained"
            )
            self.assertEqual(metric.type, "gauge")
            self.assertEqual(metric.samples[0].value, count)
            self.assertNotIn("frigate_camera_events", [m.name for m in metrics])
