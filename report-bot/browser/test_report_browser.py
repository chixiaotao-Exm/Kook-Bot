import io
import json
import threading
import os
import types
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

from report_browser import (BrowserBridge, BridgeError, CATEGORY, EXPECTED_FIELDS,
                            FETCH_SCRIPT, FORM_ID, FormMarkers, LANDING_URL,
                            MAX_RESPONSE, SESSION_URL, SUBMIT_URL, create_app,
                            UpstreamBrowser, validate_body)


TOKEN = "a" * 64
AUTH = "Bearer " + TOKEN


def form(**replacements):
    data = {
        "request[ticket_form_id]": FORM_ID,
        "request[custom_fields][5050432733209]": "Player_01",
        "request[subject]": "Please review Player_01",
        "request[description]": "<p>中文 description &amp; escaped evidence</p>",
        "request[description_mimetype]": "text/html",
        "authenticity_token": "csrf+sample/==",
        "request[anonymous_requester_email]": "reporter@example.test",
        "request[custom_fields][4413697824537]": "12345678901234567",
        "request[custom_fields][4413716837017]": "Reporter_01",
        "request[custom_fields][114102354993]": "english",
        "request[custom_fields][5040844547865]": CATEGORY,
    }
    data.update(replacements)
    return data


class NoTimer:
    def __init__(self, delay, callback):
        self.delay, self.callback, self.cancelled = delay, callback, False

    def start(self):
        pass

    def cancel(self):
        self.cancelled = True


class Backend:
    def __init__(self):
        self.calls = []
        self.responses = []
        self.prepare_error = None

    def prepare(self, sid):
        self.calls.append(("prepare", sid))
        if self.prepare_error:
            raise self.prepare_error
        return object()

    def fetch(self, driver, method, url, body):
        self.calls.append((method, url, body))
        result = self.responses.pop(0) if self.responses else {
            "status": 200, "url": url, "body": "ok", "opaqueRedirect": False}
        if isinstance(result, Exception):
            raise result
        return result

    def close(self, sid):
        self.calls.append(("close", sid))


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.backend = Backend()
        self.now = 1000
        self.exits = []
        self.timers = []

        def timer(delay, callback):
            item = NoTimer(delay, callback)
            self.timers.append(item)
            return item

        self.bridge = BrowserBridge(self.backend, TOKEN, clock=lambda: self.now,
                                    fatal=self.exits.append, timer_factory=timer)

    def prepare(self):
        return self.bridge.handle("/prepare", {}, AUTH)["sessionId"]

    def request(self, sid, method="POST", url=SUBMIT_URL, body=None):
        payload = {"sessionId": sid, "method": method, "url": url}
        if method == "POST":
            payload["body"] = urlencode(form()) if body is None else body
        return self.bridge.handle("/request", payload, AUTH)

    def assert_error(self, code, callback):
        with self.assertRaises(BridgeError) as ctx:
            callback()
        self.assertEqual(code, ctx.exception.code)

    def test_authentication_runs_before_any_browser_or_payload(self):
        for value in (None, "", "Bearer " + "b" * 64, TOKEN, "Bearer \u00e9"):
            self.assert_error("unauthorized", lambda: self.bridge.handle("/prepare", {}, value))
        self.assertEqual([], self.backend.calls)
        with self.assertRaises(ValueError):
            BrowserBridge(self.backend, "short")

    def test_prepare_is_exact_empty_request_and_only_one_session(self):
        self.assert_error("invalid_request", lambda: self.bridge.handle("/prepare", {"url": "https://bad.test"}, AUTH))
        sid = self.prepare()
        self.assertEqual(36, len(sid))
        self.assert_error("browser_busy", self.prepare)
        self.assertEqual([("prepare", sid)], self.backend.calls)

    def test_concurrent_requests_are_rejected_without_another_driver_call(self):
        self.bridge.lock.acquire()
        try:
            self.assert_error("browser_busy", self.prepare)
        finally:
            self.bridge.lock.release()
        self.assertEqual([], self.backend.calls)

    def test_preparation_failure_is_generic_and_closes_partial_session(self):
        self.backend.prepare_error = RuntimeError("secret private response")
        self.assert_error("form_unavailable", self.prepare)
        self.assertEqual(["prepare", "close"], [item[0] for item in self.backend.calls])
        self.assertIsNone(self.bridge.session)

    def test_preparation_watchdog_includes_failure_cleanup(self):
        self.backend.prepare_error = RuntimeError("failed")
        def close(_sid):
            self.assertEqual([42, 10], [timer.delay for timer in self.timers])
            self.assertFalse(self.timers[0].cancelled)
            self.assertFalse(self.timers[1].cancelled)
        self.backend.close = close
        self.assert_error("form_unavailable", self.prepare)
        self.assertTrue(all(timer.cancelled for timer in self.timers))

    def test_arbitrary_endpoints_methods_and_extra_options_fail_before_browser(self):
        sid = self.prepare()
        for method, url in [("GET", "https://example.test/"), ("POST", LANDING_URL),
                            ("GET", SESSION_URL + "?x=1"), ("PUT", SUBMIT_URL),
                            ("GET", "https://support.pubg.com@bad.test/hc/zh-cn")]:
            self.assert_error("invalid_request", lambda: self.request(sid, method, url))
        self.assert_error("invalid_request", lambda: self.bridge.handle("/request", {
            "sessionId": sid, "method": "GET", "url": SESSION_URL, "headers": {}}, AUTH))
        self.assert_error("not_found", lambda: self.bridge.handle("/v1", {}, AUTH))
        self.assertEqual(1, len(self.backend.calls))

    def test_exact_body_encoding_is_forwarded_without_decode_reencode(self):
        sid = self.prepare()
        encoded = urlencode(form())
        self.assertEqual(encoded, validate_body(encoded))
        self.request(sid, body=encoded)
        self.assertEqual(("POST", SUBMIT_URL, encoded), self.backend.calls[-1])

    def test_missing_duplicate_extra_and_invalid_fields_do_not_consume_post(self):
        sid = self.prepare()
        valid = urlencode(form())
        missing = form()
        del missing["authenticity_token"]
        bodies = [valid + "&authenticity_token=second", valid + "&unexpected=value",
                  urlencode(missing), valid.replace("csrf%2B", "csrf%GG"),
                  urlencode(form(**{"request[ticket_form_id]": "wrong"})),
                  urlencode(form(**{"request[custom_fields][5040844547865]": "wrong"})),
                  urlencode(form(**{"request[subject]": "bad\nvalue"})),
                  urlencode(form(**{"request[custom_fields][5050432733209]": "a/b"})),
                  urlencode(form(**{"request[anonymous_requester_email]": "not-email"})),
                  urlencode(form(**{"request[description]": "x" * 72021})),
                  "x" * (128 * 1024 + 1)]
        for body in bodies:
            self.assert_error("invalid_request", lambda: self.request(sid, body=body))
        self.assertFalse(self.bridge.session.posted)
        self.assertEqual(1, len(self.backend.calls))
        self.request(sid, body=valid)

    def test_second_post_is_blocked_after_success(self):
        sid = self.prepare()
        self.request(sid)
        self.assert_error("already_submitted", lambda: self.request(sid))
        self.assertEqual(1, sum(item[0] == "POST" for item in self.backend.calls))

    def test_second_post_is_blocked_after_driver_timeout_or_exception(self):
        sid = self.prepare()
        self.backend.responses = [TimeoutError("private details")]
        self.assert_error("browser_failed", lambda: self.request(sid))
        self.assert_error("already_submitted", lambda: self.request(sid))
        self.assertEqual(1, sum(item[0] == "POST" for item in self.backend.calls))

    def test_opaque_post_redirect_uses_only_one_fixed_landing_get(self):
        sid = self.prepare()
        self.backend.responses = [
            {"status": 0, "url": SUBMIT_URL, "body": "", "opaqueRedirect": True},
            {"status": 200, "url": LANDING_URL, "body": "official flash", "opaqueRedirect": False},
        ]
        self.assertEqual({"status": 200, "url": LANDING_URL, "body": "official flash"}, self.request(sid))
        self.assertEqual(["prepare", "POST", "GET"], [item[0] for item in self.backend.calls])
        self.assertEqual(("GET", LANDING_URL, None), self.backend.calls[-1])

    def test_opaque_get_redirect_is_not_followed(self):
        sid = self.prepare()
        self.backend.responses = [{"status": 0, "url": SESSION_URL, "body": "", "opaqueRedirect": True}]
        self.assertEqual({"status": 0, "url": SESSION_URL, "body": ""}, self.request(sid, "GET", SESSION_URL))
        self.assertEqual(2, len(self.backend.calls))

    def test_redirected_landing_is_unknown_without_any_third_request(self):
        sid = self.prepare()
        self.backend.responses = [
            {"status": 0, "url": SUBMIT_URL, "body": "", "opaqueRedirect": True},
            {"status": 0, "url": LANDING_URL, "body": "", "opaqueRedirect": True},
        ]
        self.assertEqual(0, self.request(sid)["status"])
        self.assertEqual(3, len(self.backend.calls))

    def test_real_http_errors_are_preserved_not_fabricated_as_200(self):
        sid = self.prepare()
        self.backend.responses = [{"status": 403, "url": SUBMIT_URL, "body": "blocked", "opaqueRedirect": False}]
        self.assertEqual(403, self.request(sid)["status"])
        self.assertEqual(2, len(self.backend.calls))

    def test_invalid_browser_responses_and_oversize_are_rejected(self):
        sid = self.prepare()
        for result in [{"error": "private"},
                       {"status": 200, "url": "https://bad.test", "body": "", "opaqueRedirect": False},
                       {"status": True, "url": SESSION_URL, "body": "", "opaqueRedirect": False},
                       {"status": 200, "url": SESSION_URL, "body": "x" * (MAX_RESPONSE + 1), "opaqueRedirect": False}]:
            self.backend.responses = [result]
            self.assert_error("browser_failed", lambda: self.request(sid, "GET", SESSION_URL))

    def test_expired_session_is_destroyed_before_any_network_request(self):
        sid = self.prepare()
        self.now += 121
        self.assert_error("session_unavailable", lambda: self.request(sid))
        self.assertEqual(["prepare", "close"], [item[0] for item in self.backend.calls])
        new_sid = self.prepare()
        self.assertNotEqual(sid, new_sid)

    def test_close_is_idempotent_and_other_ids_do_not_close_current_browser(self):
        sid = self.prepare()
        self.bridge.handle("/close", {"sessionId": "00000000-0000-0000-0000-000000000000"}, AUTH)
        self.assertIsNotNone(self.bridge.session)
        for _ in range(2):
            self.assertEqual({"ok": True}, self.bridge.handle("/close", {"sessionId": sid}, AUTH))
        self.assertEqual(1, sum(item[0] == "close" for item in self.backend.calls))

    def test_watchdog_fails_closed_and_never_frees_session_for_another_post(self):
        sid = self.prepare()
        self.timers[-1].callback()
        self.assertEqual([70], self.exits)
        self.assertFalse(self.bridge.ready)
        self.assert_error("browser_unavailable", lambda: self.request(sid))
        self.assertEqual(1, len(self.backend.calls))

    def test_operation_watchdogs_are_bounded_and_cancelled(self):
        sid = self.prepare()
        self.request(sid)
        self.bridge.handle("/close", {"sessionId": sid}, AUTH)
        self.assertEqual([42, 24, 10], [timer.delay for timer in self.timers])
        self.assertTrue(all(timer.cancelled for timer in self.timers))

    def test_form_requires_all_real_fields_inside_correct_post_form(self):
        fields = ["request[subject]", "request[description]", "request[anonymous_requester_email]",
                  "request[custom_fields][5050432733209]", "authenticity_token"]
        inputs = "".join('<input name="' + field + '">' for field in fields)
        for html, expected in [
            ('<form action="/hc/zh-cn/requests" method="post">' + inputs + '</form>', True),
            ('<form action="https://bad.test" method="post">' + inputs + '</form>', False),
            ('<form action="/hc/zh-cn/requests" method="get">' + inputs + '</form>', False),
            ('<h1>Just a moment...</h1>' + inputs, False),
        ]:
            parser = FormMarkers()
            parser.feed(html)
            self.assertEqual(expected, parser.found)


class AdapterTests(unittest.TestCase):
    def setup_adapter(self):
        calls = []
        html = '<form method="post" action="/hc/zh-cn/requests">' + ''.join(
            '<input name="' + name + '">' for name in ["request[subject]", "request[description]",
                "request[anonymous_requester_email]", "request[custom_fields][5050432733209]", "authenticity_token"]) + '</form>'
        driver = types.SimpleNamespace(current_url=__import__("report_browser").FORM_URL,
                                        set_script_timeout=lambda value: calls.append(("timeout", value)))
        storage = types.SimpleNamespace(sessions={})
        def create(session_id, proxy):
            calls.append(("create", session_id, proxy))
            storage.sessions[session_id] = types.SimpleNamespace(driver=driver)
        storage.create = create
        storage.destroy = lambda sid: calls.append(("destroy", sid))
        def get(req):
            calls.append(("get", req))
            return types.SimpleNamespace(status="ok", solution=types.SimpleNamespace(
                url=__import__("report_browser").FORM_URL, response=html))
        adapter = UpstreamBrowser.__new__(UpstreamBrowser)
        adapter.service = types.SimpleNamespace(SESSIONS_STORAGE=storage, _cmd_request_get=get)
        adapter.request_type = lambda data: data
        adapter.proxies = {}
        return adapter, calls, driver

    def test_proxy_is_set_before_browser_creation_and_same_instance_is_destroyed(self):
        adapter, calls, driver = self.setup_adapter()
        proxy = types.SimpleNamespace(url="http://127.0.0.1:12345", close=lambda: calls.append(("proxy_close",)))
        module = types.SimpleNamespace(SessionProxy=lambda value: (calls.append(("proxy", value)) or proxy))
        with patch.dict(os.environ, {"REPORT_UPSTREAM_PROXY": "socks5://private.example"}), patch.dict("sys.modules", {"report_proxy": module}):
            self.assertIs(driver, adapter.prepare("fixed-session"))
            adapter.close("fixed-session")
        self.assertEqual(["proxy", "create", "get", "timeout", "destroy", "proxy_close"], [item[0] for item in calls])
        self.assertEqual({"url": proxy.url}, calls[1][2])
        self.assertEqual("fixed-session", calls[2][1]["session"])
        self.assertEqual("request.get", calls[2][1]["cmd"])
        self.assertEqual({}, adapter.proxies)

    def test_configured_proxy_failure_does_not_fall_back_to_direct_browser(self):
        adapter, calls, _ = self.setup_adapter()
        def fail(_):
            raise ValueError("bad proxy")
        with patch.dict(os.environ, {"REPORT_UPSTREAM_PROXY": "socks5://invalid.example"}), patch.dict("sys.modules", {"report_proxy": types.SimpleNamespace(SessionProxy=fail)}):
            with self.assertRaises(ValueError):
                adapter.prepare("fixed-session")
        self.assertEqual([], calls)

    def test_startup_warms_destructive_upstream_ua_cache_before_report_browser(self):
        template, calls, _ = self.setup_adapter()
        service = template.service
        cached = [None]
        class Driver:
            current_url = __import__("report_browser").FORM_URL
            closed = False
            def quit(self):
                self.closed = True
            def set_script_timeout(self, _value):
                if self.closed:
                    raise RuntimeError("report browser was unexpectedly closed")
        blank = Driver()
        report = Driver()
        def upstream_user_agent(driver=None):
            if cached[0] is not None:
                return cached[0]
            actual = blank if driver is None else driver
            try:
                calls.append(("initialize_ua", actual is blank))
                cached[0] = "Browser/1.0"
                return cached[0]
            finally:
                # This destructive finally block mirrors the pinned upstream.
                actual.quit()
        def create(session_id, proxy):
            calls.append(("create_report",))
            self.assertEqual("Browser/1.0", cached[0])
            service.SESSIONS_STORAGE.sessions[session_id] = types.SimpleNamespace(driver=report)
        original_get = service._cmd_request_get
        def get(req):
            result = original_get(req)
            upstream_user_agent(report)
            return result
        service._cmd_request_get = get
        service.SESSIONS_STORAGE.create = create
        modules = {"flaresolverr_service": service,
                   "utils": types.SimpleNamespace(get_current_platform=lambda: "posix", get_user_agent=upstream_user_agent),
                   "dtos": types.SimpleNamespace(V1RequestBase=lambda payload: payload)}
        with patch.dict("sys.modules", modules), patch.dict(os.environ, {"REPORT_UPSTREAM_PROXY": ""}):
            adapter = UpstreamBrowser()
            self.assertTrue(blank.closed)
            self.assertIs(report, adapter.prepare("first-report-session"))
        self.assertFalse(report.closed)
        self.assertEqual([("initialize_ua", True), ("create_report",)], calls[:2])

    def test_fetch_passes_private_body_as_argument_and_exact_origin(self):
        adapter, _, _ = self.setup_adapter()
        calls = []
        driver = types.SimpleNamespace(execute_async_script=lambda *args: calls.append(args))
        adapter.fetch(driver, "POST", SUBMIT_URL, "private-body")
        self.assertEqual(1, len(calls))
        self.assertEqual((SUBMIT_URL, "POST", "private-body", MAX_RESPONSE, 10000,
                          "https://support.pubg.com"), calls[0][1:])
        self.assertNotIn("private-body", calls[0][0])


try:
    import bottle  # noqa: F401
except ImportError:
    bottle = None


@unittest.skipIf(bottle is None, "Bottle HTTP tests run inside the pinned image")
class HttpTests(unittest.TestCase):
    def setUp(self):
        self.backend = Backend()
        self.bridge = BrowserBridge(self.backend, TOKEN, timer_factory=NoTimer)
        self.app = create_app(self.bridge)

    def call(self, path, data=None, auth=AUTH, method="POST", content_type="application/json"):
        raw = json.dumps(data).encode() if data is not None else b""
        env = {"REQUEST_METHOD": method, "PATH_INFO": path, "QUERY_STRING": "",
               "SERVER_NAME": "localhost", "SERVER_PORT": "8191", "SERVER_PROTOCOL": "HTTP/1.1",
               "wsgi.url_scheme": "http", "wsgi.input": io.BytesIO(raw), "wsgi.errors": io.StringIO(),
               "wsgi.version": (1, 0), "wsgi.multithread": False, "wsgi.multiprocess": False,
               "wsgi.run_once": False, "CONTENT_LENGTH": str(len(raw)), "CONTENT_TYPE": content_type}
        if auth is not None:
            env["HTTP_AUTHORIZATION"] = auth
        result = []
        response = b"".join(self.app(env, lambda status, headers, *_: result.append((status, headers))))
        return result[0][0], json.loads(response)

    def test_health_is_minimal_and_unlocked(self):
        self.bridge.lock.acquire()
        try:
            self.assertEqual(("200 OK", {"ok": True}), self.call("/health", auth=None, method="GET"))
        finally:
            self.bridge.lock.release()

    def test_http_auth_and_unsupported_upstream_api(self):
        self.assertEqual("401 Unauthorized", self.call("/prepare", {}, auth=None)[0])
        self.assertEqual("404 Not Found", self.call("/v1", {"cmd": "request.post"})[0])
        self.assertEqual([], self.backend.calls)

    def test_http_content_type_and_json_objects_are_required(self):
        self.assertEqual("400 Bad Request", self.call("/prepare", {}, content_type="text/plain")[0])
        self.assertEqual("400 Bad Request", self.call("/prepare", [])[0])
        status, data = self.call("/prepare", {})
        self.assertEqual("200 OK", status)
        self.assertEqual({"sessionId"}, set(data))


if __name__ == "__main__":
    unittest.main()
