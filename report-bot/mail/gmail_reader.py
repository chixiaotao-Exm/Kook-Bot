#!/usr/bin/env python3
"""Bounded, read-only Gmail receipt transport. Never prints credentials or mail logs."""

from __future__ import annotations

import datetime as dt
import email
import email.policy
import email.utils
from html.parser import HTMLParser
import imaplib
import json
import math
import os
import re
import signal
import ssl
import sys


MAX_MESSAGE_BYTES = 256 * 1024
MAX_BODY_BYTES = 64 * 1024
MAX_CANDIDATES = 50
MONTHS = {name: index for index, name in enumerate(
    ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), 1)}
CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")


class ReaderError(Exception):
    """Only its fixed code may be exposed to the caller."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class ReaderDeadline(ReaderError):
    def __init__(self):
        super().__init__("mail_unavailable")


def bounded_text(value: str, maximum: int, multiline: bool = False) -> str:
    value = CONTROL_CHARS.sub(" ", value)
    if not multiline:
        value = re.sub(r"[\r\n\t]+", " ", value)
    return value.encode("utf-8", errors="replace")[:maximum].decode("utf-8", errors="ignore").strip()


def credentials(environ: dict) -> tuple[str, str]:
    address = str(environ.get("GMAIL_ADDRESS", "")).strip()
    password = re.sub(r"\s+", "", str(environ.get("GMAIL_APP_PASSWORD", "")))
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}@(gmail|googlemail)\.com", address, re.I):
        raise ReaderError("invalid_config")
    if not re.fullmatch(r"[A-Za-z]{16}", password):
        raise ReaderError("invalid_config")
    return address, password


def request_options(request: object) -> tuple[int, int]:
    if not isinstance(request, dict):
        raise ReaderError("invalid_config")
    since = request.get("sinceMs")
    limit = request.get("limit", MAX_CANDIDATES)
    if (isinstance(since, bool) or not isinstance(since, (int, float))
            or not math.isfinite(since) or since < 0 or since > 253402214400000):
        raise ReaderError("invalid_config")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_CANDIDATES:
        raise ReaderError("invalid_config")
    return int(since), limit


def internal_date_ms(value: bytes) -> int:
    """Parse IMAP INTERNALDATE with its numeric offset, independently of host locale/TZ."""
    match = re.search(rb'INTERNALDATE "\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})"', value)
    if not match:
        raise ReaderError("mail_unavailable")
    try:
        day, month, year, hour, minute, second, sign, tz_hour, tz_minute = match.groups()
        offset_hour, offset_minute = int(tz_hour), int(tz_minute)
        if offset_hour > 23 or offset_minute > 59:
            raise ValueError("offset")
        offset = dt.timedelta(hours=offset_hour, minutes=offset_minute)
        if sign == b"-":
            offset = -offset
        parsed = dt.datetime(int(year), MONTHS[month.decode("ascii").title()], int(day),
                             int(hour), int(minute), int(second), tzinfo=dt.timezone(offset))
        return int(parsed.timestamp() * 1000)
    except (KeyError, ValueError, OverflowError):
        raise ReaderError("mail_unavailable") from None


class PlainHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.fragments = []
        self.length = 0
        self.hidden = []

    def add(self, text):
        if not self.hidden and self.length < MAX_BODY_BYTES:
            text = text[:MAX_BODY_BYTES - self.length]
            self.fragments.append(text)
            self.length += len(text)

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "head", "template"}:
            self.hidden.append(tag)
        elif tag in {"br", "p", "div", "li", "tr", "table", "h1", "h2", "h3"}:
            self.add("\n")

    def handle_endtag(self, tag):
        if self.hidden:
            if tag == self.hidden[-1]:
                self.hidden.pop()
        elif tag in {"p", "div", "li", "tr", "table", "h1", "h2", "h3"}:
            self.add("\n")

    def handle_data(self, data):
        self.add(data)


def decoded_part(part) -> str:
    payload = part.get_payload(decode=True)
    if not isinstance(payload, bytes):
        return ""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except (LookupError, UnicodeError):
        return payload.decode("utf-8", errors="replace")


def message_body(message) -> str:
    plain, html = [], []

    def visit(part):
        # Do not descend into attached forwarded messages or attached multipart parts.
        if part.get_content_disposition() == "attachment" or part.get_filename():
            return
        if part.get_content_maintype() == "message":
            return
        if part.is_multipart():
            for child in part.iter_parts():
                visit(child)
        elif part.get_content_type() == "text/plain":
            plain.append(decoded_part(part))
        elif part.get_content_type() == "text/html":
            html.append(decoded_part(part))

    visit(message)
    if plain:
        return bounded_text("\n".join(plain), MAX_BODY_BYTES, multiline=True)
    parser = PlainHTML()
    parser.feed("\n".join(html))
    parser.close()
    return bounded_text("".join(parser.fragments), MAX_BODY_BYTES, multiline=True)


def addresses(message, names) -> list[str]:
    values = [str(value) for name in names for value in message.get_all(name, [])]
    parsed = email.utils.getaddresses(values)
    return list(dict.fromkeys(bounded_text(address, 320) for _, address in parsed if address))[:20]


def parse_message(raw: bytes, uid: str, validity: str, internal_date: int) -> dict:
    message = email.message_from_bytes(raw, policy=email.policy.default)
    senders = addresses(message, ("From",))
    return {
        "id": validity + ":" + uid,
        "internalDate": internal_date,
        "subject": bounded_text(str(message.get("Subject", "")), 512),
        # Ambiguous multi-sender headers must not be promoted to an authenticated sender.
        "fromAddress": senders[0] if len(senders) == 1 else "",
        "toAddresses": addresses(message, ("To", "Cc", "Delivered-To", "X-Original-To")),
        "authenticationResults": [bounded_text(str(value), 2048)
                                  for value in message.get_all("Authentication-Results", [])[:16]],
        "bodyText": message_body(message),
    }


def require_ok(result):
    status, data = result
    if status != "OK":
        raise ReaderError("mail_unavailable")
    return data


def read_receipts(request: object, environ=None, imap_factory=None) -> dict:
    since, limit = request_options(request)
    address, password = credentials(os.environ if environ is None else environ)
    factory = imaplib.IMAP4_SSL if imap_factory is None else imap_factory
    client = None
    deadline_hit = False
    try:
        client = factory("imap.gmail.com", 993, ssl_context=ssl.create_default_context(), timeout=15)
        try:
            login_status, _ = client.login(address, password)
            if login_status != "OK":
                raise ReaderError("auth_failed")
        except imaplib.IMAP4.abort:
            raise ReaderError("mail_unavailable") from None
        except imaplib.IMAP4.error:
            raise ReaderError("auth_failed") from None
        require_ok(client.select("INBOX", readonly=True))
        _, validity_values = client.response("UIDVALIDITY")
        if not validity_values or not isinstance(validity_values[0], bytes) or not re.fullmatch(rb"\d{1,20}", validity_values[0]):
            raise ReaderError("mail_unavailable")
        validity = validity_values[0].decode("ascii")
        date = dt.datetime.fromtimestamp(since / 1000, dt.timezone.utc).date()
        if date > dt.date(1970, 1, 1):
            date -= dt.timedelta(days=1)
        month_name = tuple(MONTHS)[date.month - 1]
        search_date = f"{date.day:02d}-{month_name}-{date.year:04d}"
        found = require_ok(client.uid("search", None, "SINCE", search_date,
                                      "OR", "FROM", '"pubg.com"', "FROM", '"zendesk.com"'))
        if not found or not isinstance(found[0], bytes):
            raise ReaderError("mail_unavailable")
        raw_uids = found[0].split()
        if any(not re.fullmatch(rb"\d{1,20}", uid) for uid in raw_uids):
            raise ReaderError("mail_unavailable")
        uids = sorted(set(raw_uids), key=int, reverse=True)
        result = {"messages": [], "truncated": len(uids) > limit}
        for raw_uid in uids[:limit]:
            uid = raw_uid.decode("ascii")
            metadata = require_ok(client.uid("fetch", uid, "(UID RFC822.SIZE INTERNALDATE)"))
            metadata = b" ".join(item[0] if isinstance(item, tuple) else item
                                 for item in metadata if isinstance(item, (bytes, tuple)))
            uid_match = re.search(rb"\bUID (\d+)\b", metadata)
            size_match = re.search(rb"\bRFC822.SIZE (\d+)\b", metadata)
            if not uid_match or uid_match[1] != raw_uid or not size_match:
                # A concurrently removed message is simply absent from FETCH results.
                if not metadata:
                    continue
                raise ReaderError("mail_unavailable")
            size = int(size_match[1])
            internal_date = internal_date_ms(metadata)
            if internal_date < since:
                continue
            if size > MAX_MESSAGE_BYTES:
                result["truncated"] = True
                continue
            fetched = require_ok(client.uid("fetch", uid, "(UID BODY.PEEK[])"))
            bodies = [item for item in fetched if isinstance(item, tuple) and len(item) == 2
                      and isinstance(item[0], bytes) and isinstance(item[1], bytes)]
            if not bodies:
                continue
            if len(bodies) != 1:
                raise ReaderError("mail_unavailable")
            header, raw = bodies[0]
            body_uid = re.search(rb"\bUID (\d+)\b", header)
            if (not body_uid or body_uid[1] != raw_uid or len(raw) != size
                    or len(raw) > MAX_MESSAGE_BYTES):
                raise ReaderError("mail_unavailable")
            result["messages"].append(parse_message(raw, uid, validity, internal_date))
        return result
    except ReaderDeadline:
        deadline_hit = True
        raise
    except ReaderError:
        raise
    except Exception:
        # Protocol responses and exception strings can contain private mail content.
        raise ReaderError("mail_unavailable") from None
    finally:
        if client is not None:
            try:
                if deadline_hit:
                    client.shutdown()
                else:
                    client.logout()
            except ReaderDeadline:
                try:
                    client.shutdown()
                except Exception:
                    pass
                raise
            except Exception:
                pass


def main() -> int:
    if hasattr(signal, "SIGALRM"):
        def deadline(_signum, _frame):
            raise ReaderDeadline()
        signal.signal(signal.SIGALRM, deadline)
        signal.alarm(50)
    try:
        raw = sys.stdin.buffer.read(4097)
        if len(raw) > 4096:
            raise ReaderError("invalid_config")
        try:
            request = json.loads(raw)
        except (ValueError, UnicodeError):
            raise ReaderError("invalid_config") from None
        result = read_receipts(request)
        print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
        return 0
    except ReaderError as error:
        print(json.dumps({"error": error.code}, separators=(",", ":")))
        return 1
    except Exception:
        print('{"error":"mail_unavailable"}')
        return 1
    finally:
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)


if __name__ == "__main__":
    sys.exit(main())
