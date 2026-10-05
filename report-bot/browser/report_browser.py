"""Private, fixed-destination browser transport; never exposes FlareSolverr /v1.

FlareSolverr is used only to open the official form. Its request.post helper is
deliberately excluded: it can replay POSTs when setting cookies and reports a
synthetic HTTP 200. All actual requests below use a single same-origin fetch.
"""

import hmac
import json
import logging
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import parse_qsl, urljoin

ORIGIN = "https://support.pubg.com"
FORM_ID = "5040224537369"
FORM_URL = ORIGIN + "/hc/zh-cn/requests/new?ticket_form_id=" + FORM_ID
SESSION_URL = ORIGIN + "/api/v2/help_center/sessions.json"
SUBMIT_URL = ORIGIN + "/hc/zh-cn/requests"
LANDING_URL = ORIGIN + "/hc/zh-cn"
CATEGORY = "__dc.issue_illegal_program_usage__"
MAX_BODY = 128 * 1024
MAX_RESPONSE = 512 * 1024
MAX_ENVELOPE = 256 * 1024
SESSION_TTL = 120
FETCH_TIMEOUT_MS = 10000
EXPECTED_FIELDS = frozenset({
    "request[ticket_form_id]", "request[custom_fields][5050432733209]",
    "request[subject]", "request[description]", "request[description_mimetype]",
    "authenticity_token", "request[anonymous_requester_email]",
    "request[custom_fields][4413697824537]", "request[custom_fields][4413716837017]",
    "request[custom_fields][114102354993]", "request[custom_fields][5040844547865]",
})
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class BridgeError(Exception):
    """Only fixed, non-sensitive error codes are exposed to the caller."""

    def __init__(self, status=502, code="browser_failed"):
        super().__init__(code)
        self.status = status
        self.code = code


def valid_session_id(value):
    return isinstance(value, str) and re.fullmatch(
        r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", value) is not None


def validate_body(body):
    if not isinstance(body, str) or not body or len(body.encode("utf-8")) > MAX_BODY:
        raise BridgeError(400, "invalid_request")
    if CONTROL.search(body) or re.search(r"%(?![0-9a-fA-F]{2})", body):
        raise BridgeError(400, "invalid_request")
    try:
        pairs = parse_qsl(body, keep_blank_values=True, strict_parsing=True,
                          errors="strict", max_num_fields=len(EXPECTED_FIELDS))
    except (ValueError, UnicodeError):
        raise BridgeError(400, "invalid_request") from None
    fields = dict(pairs)
    if len(pairs) != len(EXPECTED_FIELDS) or set(fields) != EXPECTED_FIELDS:
        raise BridgeError(400, "invalid_request")
    if any(not value or CONTROL.search(value) for value in fields.values()):
        raise BridgeError(400, "invalid_request")
    if (fields["request[ticket_form_id]"] != FORM_ID or
            fields["request[description_mimetype]"] != "text/html" or
            fields["request[custom_fields][5040844547865]"] != CATEGORY or
            not re.fullmatch(r"[A-Za-z0-9_-]{3,32}", fields["request[custom_fields][5050432733209]"]) or
            not re.fullmatch(r"[0-9]{17}", fields["request[custom_fields][4413697824537]"]) or
            not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{0,63}", fields["request[custom_fields][114102354993]"])):
        raise BridgeError(400, "invalid_request")
    limits = {"request[subject]": 200, "request[description]": 72020,
              "request[anonymous_requester_email]": 254,
              "request[custom_fields][4413716837017]": 128, "authenticity_token": 4096}
    if any(len(fields[key]) > limit for key, limit in limits.items()):
        raise BridgeError(400, "invalid_request")
    if (not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", fields["request[anonymous_requester_email]"]) or
            re.search(r"\s", fields["authenticity_token"])):
        raise BridgeError(400, "invalid_request")
    return body


class FormMarkers(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_form = False
        self.found = False
        self.names = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form":
            self.in_form = (attrs.get("method", "").lower() == "post" and
                            urljoin(FORM_URL, attrs.get("action", "")) == SUBMIT_URL)
        if self.in_form and tag in {"input", "select", "textarea"}:
            self.names.add(attrs.get("name"))

    def handle_endtag(self, tag):
        if tag == "form" and self.in_form:
            required = {"request[subject]", "request[description]",
                        "request[anonymous_requester_email]",
                        "request[custom_fields][5050432733209]", "authenticity_token"}
            self.found = self.found or required <= self.names
            self.in_form = False
            self.names.clear()


# Arguments, including the form body, are passed separately to WebDriver and are
# never interpolated into JavaScript. Manual redirects prohibit POST 307 replay.
FETCH_SCRIPT = r"""
const [url, method, body, limit, timeoutMs, allowedOrigin] = arguments;
const done = arguments[arguments.length - 1];
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
(async () => {
  if (location.origin !== allowedOrigin) throw new Error('origin');
  const options = {method, credentials: 'include', mode: 'same-origin',
    redirect: 'manual', cache: 'no-store', signal: controller.signal,
    headers: {'Accept': 'text/html,application/json'}};
  if (method === 'POST') {
    options.headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    options.body = body;
  }
  const response = await fetch(url, options);
  if (response.type === 'opaqueredirect') {
    done({status: 0, url, body: '', opaqueRedirect: true}); return;
  }
  if (response.url !== url || response.redirected) throw new Error('redirect');
  const advertised = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertised) && advertised > limit) throw new Error('size');
  const reader = response.body?.getReader();
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let size = 0, text = '';
  if (reader) {
    try {
      while (true) {
        const {value, done: ended} = await reader.read();
        if (ended) break;
        size += value.byteLength;
        if (size > limit) { await reader.cancel(); throw new Error('size'); }
        text += decoder.decode(value, {stream: true});
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
  }
  done({status: response.status, url: response.url, body: text, opaqueRedirect: false});
})().catch(() => {controller.abort(); done({error: 'browser_failed'});})
  .finally(() => clearTimeout(timer));
"""


class UpstreamBrowser:
    """Adapter around the pinned FlareSolverr modules; imported only in runtime."""

    def __init__(self):
        import flaresolverr_service
        import utils
        from dtos import V1RequestBase
        utils.get_current_platform()
        # Upstream get_user_agent(driver) always quits the supplied driver while
        # filling its empty cache. Initialize that cache with its own throwaway
        # blank browser, as FlareSolverr's normal startup does, before creating
        # any report session whose cookies and CSRF state must survive prepare.
        utils.get_user_agent()
        self.service = flaresolverr_service
        self.request_type = V1RequestBase
        self.proxies = {}

    def prepare(self, session_id):
        # This is exclusively GET; never invoke the upstream HTTP controller or
        # request.post (both can log private bodies and request.post can replay).
        proxy_config = None
        if os.environ.get("REPORT_UPSTREAM_PROXY"):
            from report_proxy import SessionProxy
            proxy = SessionProxy(os.environ["REPORT_UPSTREAM_PROXY"])
            self.proxies[session_id] = proxy
            proxy_config = {"url": proxy.url}
        # Explicit creation is essential: request.get ignores req.proxy when a
        # session id is supplied. The browser must use one fixed proxy for its
        # entire lifetime, including the original form and subsequent fetches.
        self.service.SESSIONS_STORAGE.create(session_id=session_id, proxy=proxy_config)
        result = self.service._cmd_request_get(self.request_type({
            "cmd": "request.get", "session": session_id, "url": FORM_URL,
            "maxTimeout": 38000, "returnOnlyCookies": False,
        }))
        solution = result.solution
        if result.status != "ok" or solution is None or solution.url != FORM_URL:
            raise BridgeError(502, "form_unavailable")
        html = solution.response
        if not isinstance(html, str) or len(html.encode("utf-8")) > MAX_RESPONSE:
            raise BridgeError(502, "form_unavailable")
        markers = FormMarkers()
        markers.feed(html)
        if not markers.found:
            raise BridgeError(502, "form_unavailable")
        # Do not call storage.get(): it may silently create a replacement browser.
        session = self.service.SESSIONS_STORAGE.sessions.get(session_id)
        if session is None or session.driver.current_url != FORM_URL:
            raise BridgeError(502, "form_unavailable")
        session.driver.set_script_timeout(11)
        return session.driver

    def fetch(self, driver, method, url, body):
        return driver.execute_async_script(FETCH_SCRIPT, url, method, body,
                                           MAX_RESPONSE, FETCH_TIMEOUT_MS, ORIGIN)

    def close(self, session_id):
        try:
            self.service.SESSIONS_STORAGE.destroy(session_id)
        finally:
            proxy = self.proxies.pop(session_id, None)
            if proxy is not None:
                proxy.close()


@dataclass
class Session:
    id: str
    expires: float
    driver: object = None
    posted: bool = False


class BrowserBridge:
    def __init__(self, backend, token, clock=time.monotonic, fatal=os._exit,
                 timer_factory=threading.Timer):
        if (not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token)):
            raise ValueError("Invalid browser authentication configuration")
        self.backend = backend
        self.token = token
        self.clock = clock
        self.fatal = fatal
        self.timer_factory = timer_factory
        self.lock = threading.Lock()
        self.session = None
        self.ready = True

    def authorize(self, header):
        if not isinstance(header, str) or not hmac.compare_digest(
                header.encode("utf-8"), ("Bearer " + self.token).encode("ascii")):
            raise BridgeError(401, "unauthorized")

    def _watch(self, seconds, work):
        # A timed-out Selenium command may still run inside Chromium. Kill this
        # whole isolated service instead of freeing its lock and risking overlap.
        def expired():
            self.ready = False
            self.fatal(70)
        timer = self.timer_factory(seconds, expired)
        timer.daemon = True
        timer.start()
        try:
            result = work()
            if not self.ready:
                raise BridgeError(503, "browser_unavailable")
            return result
        finally:
            timer.cancel()

    def _close(self):
        current = self.session
        if current is not None:
            # Keep the reservation if cleanup fails; no second browser is allowed.
            self._watch(10, lambda: self.backend.close(current.id))
            self.session = None

    def _reap(self):
        if self.session is not None and self.clock() >= self.session.expires:
            self._close()

    def reap(self):
        if self.lock.acquire(blocking=False):
            try:
                self._reap()
            except Exception:
                self.ready = False
                self.fatal(70)
            finally:
                self.lock.release()

    def handle(self, path, payload, authorization):
        self.authorize(authorization)
        if not self.ready:
            raise BridgeError(503, "browser_unavailable")
        if not isinstance(payload, dict):
            raise BridgeError(400, "invalid_request")
        if not self.lock.acquire(blocking=False):
            raise BridgeError(409, "browser_busy")
        try:
            self._reap()
            if path == "/prepare":
                if payload:
                    raise BridgeError(400, "invalid_request")
                if self.session is not None:
                    raise BridgeError(409, "browser_busy")
                current = Session(str(uuid.uuid4()), self.clock() + SESSION_TTL)
                self.session = current
                def prepare_work():
                    try:
                        current.driver = self.backend.prepare(current.id)
                        current.expires = self.clock() + SESSION_TTL
                    except Exception:
                        self._close()
                        raise BridgeError(502, "form_unavailable") from None
                # Include failure cleanup in the overall deadline: the Node
                # caller must not time out while a hidden browser keeps working.
                self._watch(42, prepare_work)
                return {"sessionId": current.id}
            if path == "/close":
                if set(payload) != {"sessionId"} or not valid_session_id(payload["sessionId"]):
                    raise BridgeError(400, "invalid_request")
                if self.session is not None and self.session.id == payload["sessionId"]:
                    self._close()
                return {"ok": True}
            if path != "/request":
                raise BridgeError(404, "not_found")
            return self._request(payload)
        except BridgeError:
            raise
        except Exception:
            raise BridgeError(502, "browser_failed") from None
        finally:
            self.lock.release()

    def _request(self, payload):
        method = payload.get("method")
        expected = {"sessionId", "method", "url"} | ({"body"} if method == "POST" else set())
        if (set(payload) != expected or not valid_session_id(payload.get("sessionId")) or
                (method == "GET" and payload.get("url") not in {SESSION_URL, LANDING_URL}) or
                (method == "POST" and payload.get("url") != SUBMIT_URL) or
                method not in {"GET", "POST"}):
            raise BridgeError(400, "invalid_request")
        if method == "POST":
            validate_body(payload["body"])
        current = self.session
        if current is None or current.id != payload["sessionId"]:
            raise BridgeError(404, "session_unavailable")
        if method == "POST":
            if current.posted:
                raise BridgeError(409, "already_submitted")
            # Consume before executing: browser exceptions and client disconnects
            # must never make this session eligible for another report attempt.
            current.posted = True

        def perform():
            result = self._fetch(current, method, payload["url"], payload.get("body"))
            if method == "POST" and result.pop("opaqueRedirect"):
                # Fetch does not disclose a manual redirect's status/location.
                # Never follow that destination. Read this one fixed GET page in
                # the same fresh browser, allowing the caller to inspect its flash.
                result = self._fetch(current, "GET", LANDING_URL, None)
            result.pop("opaqueRedirect", None)
            return result
        return self._watch(24, perform)

    def _fetch(self, current, method, url, body):
        result = self.backend.fetch(current.driver, method, url, body)
        if (not isinstance(result, dict) or set(result) != {"status", "url", "body", "opaqueRedirect"} or
                type(result["status"]) is not int or not 0 <= result["status"] <= 599 or
                result["url"] != url or type(result["opaqueRedirect"]) is not bool or
                not isinstance(result["body"], str) or len(result["body"].encode("utf-8")) > MAX_RESPONSE or
                (result["opaqueRedirect"] and (result["status"] != 0 or result["body"] != ""))):
            raise BridgeError(502, "browser_failed")
        return dict(result)


def create_app(bridge):
    from bottle import Bottle, request, response
    app = Bottle(catchall=True)

    @app.hook("after_request")
    def response_headers():
        response.set_header("Cache-Control", "no-store")
        response.set_header("X-Content-Type-Options", "nosniff")

    @app.get("/health")
    def health():
        response.status = 200 if bridge.ready else 503
        return {"ok": bridge.ready}

    def dispatch():
        try:
            bridge.authorize(request.get_header("Authorization"))
            if request.content_type != "application/json":
                raise BridgeError(400, "invalid_request")
            length = request.content_length
            if not 0 < length <= MAX_ENVELOPE:
                raise BridgeError(413, "request_too_large")
            raw = request.body.read(MAX_ENVELOPE + 1)
            if len(raw) != length:
                raise BridgeError(400, "invalid_request")
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeError):
                raise BridgeError(400, "invalid_request") from None
            return bridge.handle(request.path, payload, request.get_header("Authorization"))
        except BridgeError as error:
            response.status = error.status
            return {"error": error.code}
        except Exception:
            response.status = 502
            return {"error": "browser_failed"}

    for endpoint in ("/prepare", "/request", "/close"):
        app.post(endpoint)(dispatch)

    @app.error(404)
    @app.error(405)
    @app.error(500)
    def generic_error(error):
        response.content_type = "application/json"
        return json.dumps({"error": "request_failed"})

    return app


def main():
    os.umask(0o077)
    os.environ["LOG_HTML"] = "false"
    os.environ["LOG_LEVEL"] = "warning"
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    for name in ("selenium", "urllib3", "undetected_chromedriver"):
        logging.getLogger(name).setLevel(logging.CRITICAL)
    bridge = BrowserBridge(UpstreamBrowser(), os.environ.get("REPORT_BROWSER_TOKEN"))
    from waitress import serve
    def reaper():
        while True:
            time.sleep(5)
            bridge.reap()
    threading.Thread(target=reaper, daemon=True).start()
    serve(create_app(bridge), host="0.0.0.0", port=8191, threads=4,
          max_request_body_size=MAX_ENVELOPE, channel_timeout=50,
          expose_tracebacks=False, ident="report-browser")


if __name__ == "__main__":
    main()
