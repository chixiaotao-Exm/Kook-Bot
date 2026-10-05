import contextlib
import datetime as dt
from email.message import EmailMessage
import imaplib
import io
import json
import ssl
import unittest
from unittest.mock import patch

import gmail_reader as reader


ENV = {"GMAIL_ADDRESS": "reporter@gmail.com", "GMAIL_APP_PASSWORD": "abcd efgh ijkl mnop"}
STAMP = int(dt.datetime(2026, 10, 5, 13, tzinfo=dt.timezone.utc).timestamp() * 1000)


def mail_bytes(subject="[PUBG Support] Ticket #123", body="Your request (123) has been received."):
    message = EmailMessage()
    message["From"] = "PUBG Support <support@pubg.com>"
    message["To"] = "reporter@gmail.com"
    message["Subject"] = subject
    message["Authentication-Results"] = "mx.google.com; dkim=pass header.i=@pubg.com; spf=pass"
    message.set_content(body)
    return message.as_bytes()


class FakeIMAP:
    def __init__(self, *args, **kwargs):
        self.connection = (args, kwargs)
        self.commands = []
        self.messages = {"7": mail_bytes()}
        self.dates = {}
        self.sizes = {}
        self.validity = b"7788"
        self.search_override = None
        self.login_error = None
        self.fetch_override = None
        self.logged_out = False
        self.was_shutdown = False

    def login(self, address, password):
        self.commands.append(("login", address, password))
        if self.login_error:
            raise self.login_error
        return "OK", [b"authenticated"]

    def select(self, folder, readonly=False):
        self.commands.append(("select", folder, readonly))
        return "OK", [b"1"]

    def response(self, key):
        self.commands.append(("response", key))
        return key, [self.validity]

    def uid(self, command, *args):
        self.commands.append((command, *args))
        if command == "search":
            return "OK", [self.search_override if self.search_override is not None else
                          " ".join(self.messages).encode("ascii")]
        if command == "fetch":
            uid, spec = args
            if self.fetch_override is not None:
                return self.fetch_override(uid, spec)
            if spec == "(UID RFC822.SIZE INTERNALDATE)":
                date = self.dates.get(uid, "05-Oct-2026 09:00:00 -0400")
                size = self.sizes.get(uid, len(self.messages[uid]))
                return "OK", [f'1 (UID {uid} RFC822.SIZE {size} INTERNALDATE "{date}")'.encode()]
            if spec == "(UID BODY.PEEK[])":
                return "OK", [(f"1 (UID {uid} BODY[] {{{len(self.messages[uid])}}}".encode(), self.messages[uid]), b")"]
        raise AssertionError("Unexpected IMAP command")

    def logout(self):
        self.logged_out = True
        self.commands.append(("logout",))
        return "BYE", []

    def shutdown(self):
        self.was_shutdown = True


class GmailReaderTests(unittest.TestCase):
    def run_reader(self, client=None, request=None, environ=None):
        client = client or FakeIMAP()
        calls = []

        def connect(*args, **kwargs):
            calls.append((args, kwargs))
            return client

        result = reader.read_receipts(request or {"sinceMs": STAMP - 1000},
                                      ENV if environ is None else environ, connect)
        self.assertTrue(client.logged_out)
        self.assertEqual(calls[0][0], ("imap.gmail.com", 993))
        context = calls[0][1]["ssl_context"]
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual(calls[0][1]["timeout"], 15)
        return result, client

    def test_readonly_peek_tls_sender_search_and_uidvalidity(self):
        result, client = self.run_reader()
        self.assertEqual(result["messages"][0]["id"], "7788:7")
        self.assertEqual(result["messages"][0]["internalDate"], STAMP)
        self.assertFalse(result["truncated"])
        self.assertIn(("select", "INBOX", True), client.commands)
        self.assertIn(("search", None, "SINCE", "04-Oct-2026", "OR", "FROM", '"pubg.com"', "FROM", '"zendesk.com"'), client.commands)
        self.assertIn(("fetch", "7", "(UID BODY.PEEK[])"), client.commands)
        self.assertFalse(any(command[0].upper() in {"STORE", "APPEND", "COPY", "CLOSE", "EXPUNGE", "DELETE"} for command in client.commands))
        self.assertEqual(client.commands[0], ("login", "reporter@gmail.com", "abcdefghijklmnop"))

    def test_limit_most_recent_and_truncation(self):
        client = FakeIMAP()
        client.messages = {str(number): mail_bytes() for number in range(1, 70)}
        result, client = self.run_reader(client, {"sinceMs": STAMP - 1, "limit": 2})
        self.assertTrue(result["truncated"])
        self.assertEqual([item["id"] for item in result["messages"]], ["7788:69", "7788:68"])
        self.assertEqual(len([command for command in client.commands if command[0] == "fetch"]), 4)

    def test_default_maximum_is_fifty(self):
        client = FakeIMAP()
        client.messages = {str(number): mail_bytes() for number in range(1, 70)}
        result, _ = self.run_reader(client)
        self.assertEqual(len(result["messages"]), 50)
        self.assertTrue(result["truncated"])

    def test_size_checked_before_body_and_large_messages_skipped(self):
        client = FakeIMAP()
        client.sizes["7"] = reader.MAX_MESSAGE_BYTES + 1
        result, client = self.run_reader(client)
        self.assertEqual(result["messages"], [])
        self.assertTrue(result["truncated"])
        self.assertNotIn(("fetch", "7", "(UID BODY.PEEK[])"), client.commands)

    def test_old_internal_date_filtered_without_body_fetch(self):
        client = FakeIMAP()
        client.dates["7"] = "04-Oct-2026 09:00:00 -0400"
        result, client = self.run_reader(client)
        self.assertEqual(result["messages"], [])
        self.assertNotIn(("fetch", "7", "(UID BODY.PEEK[])"), client.commands)

    def test_future_and_negative_timezone_offsets_do_not_use_local_tz(self):
        self.assertEqual(reader.internal_date_ms(b'INTERNALDATE "05-Oct-2026 18:30:00 +0530"'), STAMP)
        self.assertEqual(reader.internal_date_ms(b'INTERNALDATE " 5-Oct-2026 09:00:00 -0400"'), STAMP)
        with self.assertRaises(reader.ReaderError):
            reader.internal_date_ms(b'INTERNALDATE "05-Oct-2026 18:30:00 +9999"')

    def test_mime_decoding_headers_plain_preferred_attachments_ignored(self):
        message = EmailMessage()
        message["From"] = "PUBG 客服 <support@pubg.com>"
        message["To"] = "测试 <reporter@gmail.com>"
        message["Cc"] = "other@gmail.com"
        message["Delivered-To"] = "reporter@gmail.com"
        message["Subject"] = "您的请求已收到 #123"
        message["Authentication-Results"] = "mx.google.com; dkim=pass header.d=pubg.com"
        message["Authentication-Results"] = "untrusted.example; dkim=pass"
        message.set_content("正文中文：EXAMPLE_PLAYER")
        message.add_alternative("<p>Do not choose HTML over plain text</p>", subtype="html")
        message.add_attachment(b"private attachment", maintype="text", subtype="plain", filename="private.txt")
        parsed = reader.parse_message(message.as_bytes(), "42", "1", STAMP)
        self.assertEqual(parsed["subject"], "您的请求已收到 #123")
        self.assertEqual(parsed["fromAddress"], "support@pubg.com")
        self.assertEqual(parsed["toAddresses"], ["reporter@gmail.com", "other@gmail.com"])
        self.assertEqual(len(parsed["authenticationResults"]), 2)
        self.assertEqual(parsed["bodyText"], "正文中文：EXAMPLE_PLAYER")

    def test_html_fallback_does_not_expose_scripts_css_or_fetch_remote_urls(self):
        message = EmailMessage()
        message.set_content('<html><head><title>Hidden</title></head><body><style>SECRET</style>'
                            '<script>secret()</script><p>Ticket &amp; confirmation</p>'
                            '<img src="https://tracker.invalid/pixel"><a href="https://example.invalid">Open report</a></body></html>', subtype="html")
        parsed = reader.parse_message(message.as_bytes(), "1", "1", STAMP)
        self.assertEqual(parsed["bodyText"], "Ticket & confirmation\nOpen report")
        self.assertNotIn("http", parsed["bodyText"])

    def test_attached_forwarded_message_is_ignored(self):
        message = EmailMessage()
        message.set_content("Visible receipt")
        attached = EmailMessage()
        attached.set_content("Private unrelated forwarded message")
        message.add_attachment(attached)
        self.assertEqual(reader.message_body(message), "Visible receipt")

    def test_output_limits_are_utf8_byte_limits_and_controls_cleaned(self):
        message = EmailMessage()
        message["Subject"] = "中" * 300
        message.set_content("中" * 30000 + "\x00bad")
        parsed = reader.parse_message(message.as_bytes(), "1", "1", STAMP)
        self.assertLessEqual(len(parsed["subject"].encode("utf-8")), 512)
        self.assertLessEqual(len(parsed["bodyText"].encode("utf-8")), reader.MAX_BODY_BYTES)
        self.assertNotIn("\ufffd", parsed["bodyText"])
        self.assertEqual(reader.bounded_text("a\x00\x1bb\rc\nd", 20), "a  b c d")

    def test_unknown_charset_falls_back_safely(self):
        raw = b'Content-Type: text/plain; charset="not-a-real-charset"\r\n\r\nReceipt #1'
        self.assertEqual(reader.parse_message(raw, "1", "1", STAMP)["bodyText"], "Receipt #1")

    def test_ambiguous_multi_sender_is_not_selected(self):
        raw = b'From: attacker@example.org, support@pubg.com\r\n\r\nReceipt'
        self.assertEqual(reader.parse_message(raw, "1", "1", STAMP)["fromAddress"], "")

    def test_invalid_configuration_no_connection(self):
        for config in ({}, {**ENV, "GMAIL_ADDRESS": "reporter@evil.example"},
                       {**ENV, "GMAIL_ADDRESS": "reporter@gmail.com\r\nINBOX"},
                       {**ENV, "GMAIL_APP_PASSWORD": "abcd efgh ijkl mno1"}):
            with self.subTest(config=config), self.assertRaisesRegex(reader.ReaderError, "^invalid_config$"):
                reader.read_receipts({"sinceMs": STAMP}, config,
                                     lambda *_a, **_k: self.fail("must not connect"))

    def test_invalid_request_no_connection(self):
        for request in ({}, [], {"sinceMs": True}, {"sinceMs": -1}, {"sinceMs": float("inf")},
                        {"sinceMs": STAMP, "limit": 51}, {"sinceMs": STAMP, "limit": True},
                        {"sinceMs": STAMP, "limit": 0}):
            with self.subTest(request=request), self.assertRaisesRegex(reader.ReaderError, "^invalid_config$"):
                reader.read_receipts(request, ENV, lambda *_a, **_k: self.fail("must not connect"))

    def test_login_exception_has_no_private_content(self):
        client = FakeIMAP()
        client.login_error = imaplib.IMAP4.error("secret password and private message")
        with self.assertRaisesRegex(reader.ReaderError, "^auth_failed$"):
            self.run_reader(client)
        self.assertTrue(client.logged_out)

    def test_network_exception_has_no_private_content(self):
        with self.assertRaisesRegex(reader.ReaderError, "^mail_unavailable$"):
            reader.read_receipts({"sinceMs": STAMP}, ENV,
                                 lambda *_a, **_k: (_ for _ in ()).throw(OSError("secret credentials")))

    def test_network_abort_during_login_is_not_invalid_password(self):
        client = FakeIMAP()
        client.login_error = imaplib.IMAP4.abort("private network details")
        with self.assertRaisesRegex(reader.ReaderError, "^mail_unavailable$"):
            self.run_reader(client)

    def test_overall_deadline_closes_connection_without_waiting_for_logout(self):
        client = FakeIMAP()
        client.login_error = reader.ReaderDeadline()
        with self.assertRaisesRegex(reader.ReaderDeadline, "^mail_unavailable$"):
            self.run_reader(client)
        self.assertTrue(client.was_shutdown)
        self.assertFalse(client.logged_out)

    def test_empty_inbox(self):
        client = FakeIMAP()
        client.messages = {}
        result, _ = self.run_reader(client)
        self.assertEqual(result, {"messages": [], "truncated": False})

    def test_missing_validity_fails_closed(self):
        client = FakeIMAP()
        client.validity = None
        with self.assertRaisesRegex(reader.ReaderError, "^mail_unavailable$"):
            self.run_reader(client)

    def test_malformed_search_fails_closed(self):
        client = FakeIMAP()
        client.search_override = b"7 BAD"
        with self.assertRaisesRegex(reader.ReaderError, "^mail_unavailable$"):
            self.run_reader(client)

    def test_removed_message_skipped(self):
        client = FakeIMAP()
        client.fetch_override = lambda _uid, _spec: ("OK", [None])
        result, _ = self.run_reader(client)
        self.assertEqual(result["messages"], [])

    def test_wrong_uid_or_changed_size_fails_closed(self):
        for reported_uid, size in (("8", len(mail_bytes())), ("7", 1)):
            client = FakeIMAP()
            client.fetch_override = lambda uid, spec: (
                ("OK", [f'1 (UID {reported_uid} RFC822.SIZE {size} INTERNALDATE "05-Oct-2026 13:00:00 +0000")'.encode()])
                if "SIZE" in spec else ("OK", [(b"1 (UID 7 BODY[] {1}", mail_bytes()), b")"]))
            with self.subTest(uid=reported_uid, size=size), self.assertRaisesRegex(reader.ReaderError, "^mail_unavailable$"):
                self.run_reader(client)

    def test_main_json_error_only_no_traceback(self):
        class Input:
            buffer = io.BytesIO(b'{"sinceMs":123}')
        output = io.StringIO()
        with patch.object(reader.sys, "stdin", Input()), patch.dict(reader.os.environ, {}, clear=True), contextlib.redirect_stdout(output):
            exit_code = reader.main()
        self.assertEqual(exit_code, 1)
        self.assertEqual(json.loads(output.getvalue()), {"error": "invalid_config"})

    def test_main_invalid_json_and_oversized_request(self):
        for raw in (b"oops", b" " * 4097):
            class Input:
                buffer = io.BytesIO(raw)
            output = io.StringIO()
            with patch.object(reader.sys, "stdin", Input()), contextlib.redirect_stdout(output):
                self.assertEqual(reader.main(), 1)
            self.assertEqual(json.loads(output.getvalue()), {"error": "invalid_config"})


if __name__ == "__main__":
    unittest.main()
