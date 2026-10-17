"""Default throttling on normal nginx and configured proxy login paths."""

from unittest.mock import patch

from frigate.api import auth as auth_api
from frigate.config.auth import AuthConfig
from frigate.test.http_api.test_http_fork_cov_auth import _PASSWORD, _AuthHttpTestCase


class TestDefaultLoginThrottle(_AuthHttpTestCase):
    def setUp(self):
        auth_api.limiter.reset()
        self.addCleanup(auth_api.limiter.reset)
        super().setUp()

    def test_default_login_is_throttled_after_repeated_failures(self):
        self.assertIsNotNone(AuthConfig().failed_login_rate_limit)
        codes = [
            self.client.post(
                "/login",
                json={"user": "missing", "password": "wrong"},
                headers={"x-forwarded-for": "198.51.100.20"},
            ).status_code
            for _ in range(11)
        ]
        self.assertEqual(codes[:10], [401] * 10)
        self.assertEqual(codes[10], 429)

    def test_successful_logins_do_not_consume_the_failure_budget(self):
        self._add_user("bob")
        auth_api.rateLimiter.set_limit("2/minute")
        with patch.object(auth_api.limiter, "enabled", True):
            for _ in range(3):
                response = self.client.post(
                    "/login", json={"user": "bob", "password": _PASSWORD}
                )
                self.assertEqual(response.status_code, 200)
            codes = [
                self.client.post(
                    "/login", json={"user": "bob", "password": "wrong"}
                ).status_code
                for _ in range(3)
            ]
        self.assertEqual(codes, [401, 401, 429])

    def test_nginx_appended_client_address_prevents_forwarded_header_bypass(self):
        auth_api.rateLimiter.set_limit("2/minute")
        with patch.object(auth_api.limiter, "enabled", True):
            codes = [
                self.client.post(
                    "/login",
                    json={"user": "missing", "password": "wrong"},
                    headers={"x-forwarded-for": f"192.0.2.{n}, 198.51.100.20"},
                ).status_code
                for n in range(3)
            ]
        self.assertEqual(codes, [401, 401, 429])

    def test_hourly_limit_is_enforced_independently_of_the_minute_limit(self):
        auth_api.rateLimiter.set_limit("100/minute;2/hour")
        codes = [
            self.client.post(
                "/login", json={"user": "missing", "password": "wrong"}
            ).status_code
            for _ in range(3)
        ]
        self.assertEqual(codes, [401, 401, 429])

    def test_configured_trusted_proxy_retains_per_client_budgets(self):
        self.app.frigate_config.auth.trusted_proxies = ["10.0.0.0/8"]
        auth_api.rateLimiter.set_limit("1/minute")
        with patch.object(auth_api.limiter, "enabled", True):

            def login(client):
                return self.client.post(
                    "/login",
                    json={"user": "missing", "password": "wrong"},
                    headers={"x-forwarded-for": f"{client}, 10.0.0.5"},
                ).status_code

            self.assertEqual(login("198.51.100.20"), 401)
            self.assertEqual(login("198.51.100.20"), 429)
            self.assertEqual(login("198.51.100.21"), 401)


class TestDisabledLoginThrottle(_AuthHttpTestCase):
    auth_options = {"failed_login_rate_limit": None}

    def test_null_limit_explicitly_disables_the_budget(self):
        self.assertFalse(self.app.state.limiter.enabled)
        codes = [
            self.client.post(
                "/login", json={"user": "missing", "password": "wrong"}
            ).status_code
            for _ in range(12)
        ]
        self.assertEqual(codes, [401] * 12)
