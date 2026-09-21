"""Verify the summary benchmark exercises isolated, migrated production queries."""

import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from fork.benchmarks import review_summary as workload
from frigate.models import ReviewSegment, User, UserReviewStatus


class ReviewSummaryBenchmarkTests(unittest.TestCase):
    def test_real_handler_cases_preserve_bindings_and_use_migrated_indexes(self):
        models = (ReviewSegment, UserReviewStatus, User)
        original_bindings = tuple(model._meta.database for model in models)
        responses = {}
        indexes = set()
        handler = workload.review_summary

        def record(params, user, cameras):
            if not indexes:
                indexes.update(
                    row[1]
                    for row in ReviewSegment._meta.database.execute_sql(
                        "PRAGMA index_list(reviewsegment)"
                    )
                )
            response = handler(params, user, cameras)
            responses[(params.labels, tuple(cameras), user["username"])] = json.loads(
                response.body
            )
            return response

        with patch.object(workload, "review_summary", side_effect=record):
            results = workload.benchmark(40, 2, 2)
        self.assertEqual(
            tuple(model._meta.database for model in models),
            original_bindings,
        )
        self.assertEqual(len(results), 7)
        for result in results:
            self.assertGreaterEqual(result["median_ms"], 0)
            self.assertGreaterEqual(result["p95_ms"], result["median_ms"])
            self.assertGreater(result["bytes"], 0)
            self.assertEqual(len(result["plans"]), result["queries"])
        self.assertIn("review_segment_start_time_end_time", indexes)
        restricted = responses[("all", ("camera0", "camera1"), "bob")]
        daily_total = sum(
            value["total_alert"] + value["total_detection"]
            for day, value in restricted.items()
            if day != "last24Hours"
        )
        self.assertEqual(daily_total, 10)
        no_match = next(value for key, value in responses.items() if key[0] == "absent")
        self.assertEqual(list(no_match), ["last24Hours"])
        self.assertIsNone(no_match["last24Hours"]["total_alert"])

    def test_database_closes_after_handler_failure(self):
        databases = []
        create = workload.SqliteDatabase

        def record_database(*args, **kwargs):
            db = create(*args, **kwargs)
            databases.append(db)
            return db

        with (
            patch.object(workload, "SqliteDatabase", side_effect=record_database),
            patch.object(
                workload, "review_summary", side_effect=RuntimeError("failed")
            ),
            self.assertRaisesRegex(RuntimeError, "failed"),
        ):
            workload.benchmark(8, 2, 1)
        self.assertTrue(databases[0].is_closed())

    def test_rejects_unserialized_handler_output(self):
        with (
            patch.object(workload, "review_summary", return_value={}),
            self.assertRaisesRegex(TypeError, "serialized review summary"),
        ):
            workload.benchmark(8, 2, 1)

    def test_cli_rejects_invalid_repeats_and_emits_both_workloads(self):
        with (
            patch("sys.argv", ["benchmark", "--repeats", "0"]),
            redirect_stderr(io.StringIO()),
            self.assertRaises(SystemExit) as result,
        ):
            workload.main()
        self.assertEqual(result.exception.code, 2)
        output = io.StringIO()
        with (
            patch("sys.argv", ["benchmark", "--repeats", "3"]),
            patch.object(
                workload, "benchmark", side_effect=[[{"rows": 5000}], [{"rows": 50000}]]
            ) as run,
            redirect_stdout(output),
        ):
            workload.main()
        self.assertEqual(json.loads(output.getvalue())["repeats"], 3)
        self.assertEqual(run.call_args_list[0].args, (5000, 30, 3))
        self.assertEqual(run.call_args_list[1].args, (50000, 365, 3))
