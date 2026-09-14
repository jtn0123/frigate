"""Keep HTTP test database writers from outliving their temporary files."""

import unittest

from frigate.models import Event
from frigate.test.http_api.base_http_test import BaseTestHttp


class TestHttpFixtureLifecycle(unittest.TestCase):
    def test_teardown_stops_database_writer_before_next_test(self):
        original_database = Event._meta.database
        fixture = BaseTestHttp()
        fixture.setUp(models=[Event])
        database = fixture.db
        try:
            fixture.tearDown()
            self.assertTrue(database.is_stopped())
        finally:
            database.stop()
            fixture.doCleanups()
            Event.bind(original_database)
