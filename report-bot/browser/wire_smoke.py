"""Opt-in real Chromium test against loopback fixtures only; no PUBG traffic.

Run inside the built image: python /app/wire_smoke.py
The production fetch script is executed unmodified, with the fixture origin as
its trusted-origin argument. Production's adapter always passes PUBG's origin.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlencode

from report_browser import FETCH_SCRIPT, MAX_RESPONSE


def main():
    import utils
    utils.get_current_platform()
    records = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            records.append(("GET", self.path, None))
            cookies = SimpleCookie(self.headers.get("Cookie", ""))
            expected = self.path.removeprefix("/landing/") if self.path.startswith("/landing/") else None
            cookie = cookies.get("report_test_flash")
            successful = expected in {"302", "307", "308"} and cookie is not None and cookie.value == expected
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            if successful:
                self.send_header("Set-Cookie", "report_test_flash=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax")
            self.end_headers()
            flash = [{"type": "notice", "title": "您的请求已成功提交。"}] if successful else []
            self.wfile.write(('<html><script>var data=' + json.dumps({"flash_messages": flash}, ensure_ascii=False) + ';</script></html>').encode())

        def do_POST(self):
            data = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode()
            records.append(("POST", self.path, parse_qs(data, keep_blank_values=True)))
            code = int(self.path.rsplit("/", 1)[-1])
            self.send_response(code)
            self.send_header("Location", "/would-replay")
            self.send_header("Set-Cookie", "report_test_flash=" + str(code) + "; Path=/; HttpOnly; SameSite=Lax")
            self.send_header("Content-Length", "0")
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = "http://127.0.0.1:" + str(server.server_port)
    driver = None
    try:
        driver = utils.get_webdriver()
        driver.set_page_load_timeout(15)
        driver.set_script_timeout(5)
        driver.get(origin + "/start")
        fields = {"request[subject]": "中文 space + literal", "authenticity_token": "a+b/c==",
                  "request[description]": "<p>one &amp; two</p>"}
        body = urlencode(fields)
        results = []
        for code in (302, 307, 308):
            landing_url = origin + "/landing/" + str(code)
            before = driver.execute_async_script(FETCH_SCRIPT, landing_url, "GET", None,
                                                   MAX_RESPONSE, 2000, origin)
            assert before["status"] == 200 and "您的请求已成功提交。" not in before["body"], before
            records.clear()
            result = driver.execute_async_script(FETCH_SCRIPT, origin + "/submit/" + str(code),
                                                  "POST", body, MAX_RESPONSE, 2000, origin)
            assert result == {"status": 0, "url": origin + "/submit/" + str(code),
                              "body": "", "opaqueRedirect": True}, result
            # Same rule as the bridge: fixed GET, never the Location destination.
            landing = driver.execute_async_script(FETCH_SCRIPT, landing_url, "GET", None,
                                                   MAX_RESPONSE, 2000, origin)
            assert landing["status"] == 200 and "您的请求已成功提交。" in landing["body"]
            relevant = [item for item in records if item[1] != "/favicon.ico"]
            assert [item[:2] for item in relevant] == [("POST", "/submit/" + str(code)), ("GET", "/landing/" + str(code))], relevant
            assert relevant[0][2] == {key: [value] for key, value in fields.items()}, relevant
            after = driver.execute_async_script(FETCH_SCRIPT, landing_url, "GET", None,
                                                  MAX_RESPONSE, 2000, origin)
            assert "您的请求已成功提交。" not in after["body"], after
            results.append({"redirect": code, "postCount": 1, "fixedLandingGet": True,
                            "encodingExact": True, "cookieFlashPreserved": True, "flashConsumed": True})
        print(json.dumps({"ok": True, "tests": results}))
    finally:
        if driver is not None:
            driver.quit()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
