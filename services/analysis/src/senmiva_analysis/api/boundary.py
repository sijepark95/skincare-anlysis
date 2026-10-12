import hmac
import json
import asyncio
import threading

from starlette.types import ASGIApp, Message, Receive, Scope, Send


class PrivateAnalysisBoundary:
    """Authenticate before reading an analysis body; keep even chunked bodies bounded."""

    MAX_BODY_BYTES = 4096
    EXPERIMENTAL_MAX_BODY_BYTES = ((10 * 1024 * 1024 + 2) // 3) * 4 + 4096

    def __init__(self, app: ASGIApp, api_key: str) -> None:
        self.app = app
        self._api_key = api_key.encode("utf-8")
        self._experimental_slot = threading.Lock()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def private_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                message["headers"] = [
                    *message.get("headers", []),
                    (b"cache-control", b"no-store"),
                    (b"x-content-type-options", b"nosniff"),
                ]
            await send(message)

        if scope["path"] not in ("/v1/analyze", "/v1/analyze/experimental", "/v1/analyze/openai", "/v1/analyze/color", "/v1/analyze/beauty", "/v1/generate/beauty-makeup", "/v1/analyze/beauty-complete", "/v1/generate/beauty-preview"):
            await self.app(scope, receive, private_send)
            return

        headers = scope.get("headers", [])
        keys = [value for key, value in headers if key.lower() == b"x-analysis-key"]
        if len(keys) != 1 or not hmac.compare_digest(keys[0], self._api_key):
            await self._error(401, "Invalid analysis credentials.", private_send)
            return

        if scope["method"] != "POST":
            await self.app(scope, receive, private_send)
            return

        experimental = scope["path"] in ("/v1/analyze/experimental", "/v1/analyze/openai", "/v1/analyze/color", "/v1/analyze/beauty", "/v1/generate/beauty-makeup", "/v1/analyze/beauty-complete", "/v1/generate/beauty-preview")
        maximum = self.EXPERIMENTAL_MAX_BODY_BYTES if experimental else self.MAX_BODY_BYTES

        content_types = [value for key, value in headers if key.lower() == b"content-type"]
        if len(content_types) != 1 or content_types[0].split(b";", 1)[0].strip().lower() != b"application/json":
            await self._error(415, "Analysis requests must use application/json.", private_send)
            return

        content_lengths = [value for key, value in headers if key.lower() == b"content-length"]
        if content_lengths:
            try:
                length = int(content_lengths[0])
            except ValueError:
                length = -1
            if len(content_lengths) != 1 or length < 0:
                await self._error(400, "Invalid request length.", private_send)
                return
            if length > maximum:
                await self._error(413, "Analysis request is too large.", private_send)
                return

        acquired = False
        if experimental:
            acquired = self._experimental_slot.acquire(blocking=False)
            if not acquired:
                await self._error(429, "Analysis is busy; try again.", private_send)
                return
        body = bytearray()
        try:
            deadline = asyncio.get_running_loop().time() + 10
            while True:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise TimeoutError
                message = await asyncio.wait_for(receive(), timeout=remaining)
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                if len(body) + len(chunk) > maximum:
                    await self._error(413, "Analysis request is too large.", private_send)
                    return
                body.extend(chunk)
                if not message.get("more_body", False):
                    break
            delivered = False

            async def bounded_receive() -> Message:
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}
                return await receive()

            await self.app(scope, bounded_receive, private_send)
        except TimeoutError:
            await self._error(408, "Analysis request timed out.", private_send)
        finally:
            body.clear()
            if acquired:
                self._experimental_slot.release()

    @staticmethod
    async def _error(code: int, detail: str, send: Send) -> None:
        body = json.dumps({"detail": detail}).encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": code,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        })
        await send({"type": "http.response.body", "body": body})
