"""Small bounded HTTP clients; errors never include authentication or response bodies."""
import asyncio
import json
import urllib.error
import urllib.request
from urllib.parse import urlsplit


class HTTPError(Exception):
    def __init__(self, status=0):
        self.status = status
        super().__init__(f"http_{status}" if status else "network_error")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class JSONClient:
    def __init__(self, base_url, token, timeout=20):
        parsed = urlsplit(base_url)
        if (parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1'))) or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('HTTPS or loopback URL required')
        self.base_url = base_url.rstrip('/')
        self.token = token
        self.timeout = timeout

    def request_sync(self, path, data=None):
        request = urllib.request.Request(self.base_url + path,
            data=None if data is None else json.dumps(data, ensure_ascii=False).encode(),
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json', 'Accept': 'application/json'})
        try:
            with urllib.request.build_opener(NoRedirect()).open(request, timeout=self.timeout) as response:
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise HTTPError()
                return json.loads(raw)
        except urllib.error.HTTPError as exc:
            raise HTTPError(exc.code) from None
        except (OSError, ValueError):
            raise HTTPError() from None

    async def request(self, path, data=None):
        return await asyncio.to_thread(self.request_sync, path, data)


class GameClient(JSONClient):
    async def give(self, payload):
        try:
            return await self.request('/api/v1/items/give', payload)
        except HTTPError as error:
            if error.status in (401, 403, 422):
                from delivery import DefinitiveFailure
                raise DefinitiveFailure('接口拒绝了发放请求，未调用游戏库存。') from None
            raise

    async def receipt(self, request_id):
        return await self.request('/api/v1/deliveries/' + request_id)

    async def players(self):
        return (await self.request('/api/v1/players'))['players']

    async def status(self):
        return await self.request('/api/v1/status')
