"""Ephemeral, loopback-only personal-photo testing; never used by the kiosk."""

from __future__ import annotations

import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import socket
import threading
import time
from typing import Protocol


MAX_IMAGE_BYTES = 10 * 1024 * 1024
READ_TIMEOUT_SECONDS = 10.0
MAX_CONNECTIONS = 4
ASSET_ROOT = Path(__file__).parent / "photo_ui"
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
}
CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; "
    "img-src 'self' blob:; connect-src 'self'; base-uri 'none'; "
    "frame-ancestors 'none'; form-action 'none'; worker-src 'none'"
)
SECURITY_HEADERS = {
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": CSP,
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
}
ERROR_MESSAGES = {
    400: "The request or image is invalid.",
    403: "This request must come from the local test application.",
    404: "The requested resource is unavailable.",
    405: "This request method is unavailable.",
    408: "The image upload timed out. Try again.",
    411: "A bounded image upload length is required.",
    413: "Choose an image of 10 MiB or less.",
    415: "Choose a JPEG, PNG or WebP image.",
    417: "This request framing is unavailable.",
    429: "The model is busy. Try again shortly.",
    500: "The model could not process this image.",
    503: "The local test application is unavailable.",
}


class Predictor(Protocol):
    def metadata(self) -> dict: ...

    def predict_image(self, image_bytes: bytes) -> dict: ...


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


class PhotoHTTPServer(ThreadingHTTPServer):
    """Bound both accepted work and inference without retaining uploaded bytes."""

    daemon_threads = True
    request_queue_size = MAX_CONNECTIONS
    allow_reuse_address = False

    def __init__(self, predictor: Predictor, metadata: dict, port: int) -> None:
        self.predictor = predictor
        self.model_metadata = metadata
        self.session_token = secrets.token_urlsafe(32)
        self.inference_lock = threading.Lock()
        self.connection_slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        super().__init__(("127.0.0.1", port), PhotoRequestHandler)
        self.expected_host = f"127.0.0.1:{self.server_port}"
        self.origin = f"http://{self.expected_host}"

    def process_request(self, request: socket.socket, client_address: tuple) -> None:
        if not self.connection_slots.acquire(blocking=False):
            try:
                payload = _json_bytes({"error": ERROR_MESSAGES[429]})
                headers = ["HTTP/1.1 429 Too Many Requests", "Connection: close",
                           "Content-Type: application/json; charset=utf-8", f"Content-Length: {len(payload)}",
                           *[f"{key}: {value}" for key, value in SECURITY_HEADERS.items()]]
                request.settimeout(1.0)
                request.sendall(("\r\n".join(headers) + "\r\n\r\n").encode("ascii") + payload)
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.connection_slots.release()
            raise

    def process_request_thread(self, request: socket.socket, client_address: tuple) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connection_slots.release()

    def handle_error(self, request: socket.socket, client_address: tuple) -> None:
        # Stdlib's default prints tracebacks containing request/context details.
        pass


class PhotoRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "SenmivaLocalTest"
    sys_version = ""

    def setup(self) -> None:
        self.request.settimeout(READ_TIMEOUT_SECONDS)
        super().setup()

    def log_message(self, format: str, *args: object) -> None:
        pass

    def log_error(self, format: str, *args: object) -> None:
        pass

    def handle_expect_100(self) -> bool:
        self._error(417)
        return False

    def _respond(self, status: int, payload: bytes, content_type: str) -> None:
        self.close_connection = True
        try:
            self.send_response_only(status)
            for key, value in SECURITY_HEADERS.items():
                self.send_header(key, value)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Connection", "close")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(payload)
        except OSError:
            pass

    def _error(self, status: int) -> None:
        self._respond(status, _json_bytes({"error": ERROR_MESSAGES.get(status, ERROR_MESSAGES[400])}),
                      "application/json; charset=utf-8")

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        # Never reflect request paths, verbs, parser details or exception strings.
        self._error(405 if code == 501 else code)

    def _single(self, name: str) -> str | None:
        values = self.headers.get_all(name, [])
        return values[0] if len(values) == 1 else None

    def _guard(self, *, post: bool = False) -> bool:
        if self.request_version not in ("HTTP/1.0", "HTTP/1.1"):
            self._error(400)
            return False
        if self._single("Host") != self.server.expected_host:
            self._error(403)
            return False
        sites = self.headers.get_all("Sec-Fetch-Site", [])
        if len(sites) > 1 or (sites and sites[0] not in ("same-origin", "none")):
            self._error(403)
            return False
        origins = self.headers.get_all("Origin", [])
        if len(origins) > 1 or (origins and origins[0] != self.server.origin) or (post and not origins):
            self._error(403)
            return False
        if self.headers.get_all("Transfer-Encoding", []) or self.headers.get_all("Expect", []):
            self._error(400)
            return False
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1:
            self._error(400)
            return False
        if not post and lengths and lengths[0] != "0":
            self._error(400)
            return False
        return True

    def do_GET(self) -> None:
        if not self._guard():
            return
        if self.path == "/api/model":
            payload = {**self.server.model_metadata, "csrf_token": self.server.session_token, "origin": self.server.origin}
            self._respond(200, _json_bytes(payload), "application/json; charset=utf-8")
            return
        asset = ASSETS.get(self.path)
        if asset is None:
            self._error(404)
            return
        filename, content_type = asset
        try:
            payload = (ASSET_ROOT / filename).read_bytes()
        except OSError:
            self._error(503)
            return
        self._respond(200, payload, content_type)

    def _read_image(self, length: int) -> bytes:
        deadline = time.monotonic() + READ_TIMEOUT_SECONDS
        chunks = []
        remaining = length
        while remaining:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError
            self.connection.settimeout(left)
            chunk = self.rfile.read1(min(64 * 1024, remaining))
            if not chunk:
                raise EOFError
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def do_POST(self) -> None:
        if not self._guard(post=True):
            return
        if self.path != "/api/predict":
            self._error(404)
            return
        token = self._single("X-Senmiva-Token")
        if token is None or not token.isascii() or not hmac.compare_digest(token, self.server.session_token):
            self._error(403)
            return
        length_header = self._single("Content-Length")
        if length_header is None:
            self._error(411)
            return
        if not length_header.isascii() or not length_header.isdecimal() or len(length_header) > 8:
            self._error(400)
            return
        length = int(length_header)
        if length > MAX_IMAGE_BYTES:
            self._error(413)
            return
        if length == 0:
            self._error(400)
            return
        content_type = self._single("Content-Type")
        if content_type is None or content_type.lower() not in ("image/jpeg", "image/png", "image/webp"):
            self._error(415)
            return
        if not self.server.inference_lock.acquire(blocking=False):
            self._error(429)
            return
        try:
            try:
                payload = self._read_image(length)
            except TimeoutError:
                self._error(408)
                return
            except (EOFError, OSError):
                self._error(400)
                return
            try:
                result = self.server.predictor.predict_image(payload)
                payload = b""
                encoded = _json_bytes(result)
            except Exception as error:
                from .photo_inference import PhotoInputError

                self._error(400 if isinstance(error, PhotoInputError) else 500)
                return
            self._respond(200, encoded, "application/json; charset=utf-8")
        finally:
            self.server.inference_lock.release()


def create_photo_server(predictor: Predictor, port: int = 8765) -> ThreadingHTTPServer:
    """Listen only on IPv4 loopback. Port zero is useful for isolated tests."""
    if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
        raise ValueError("Choose a valid local port.")
    metadata = predictor.metadata()
    if not isinstance(metadata, dict):
        raise ValueError("The model metadata is invalid.")
    # Copy once through JSON to avoid exposing mutable predictor state.
    metadata = json.loads(_json_bytes(metadata))
    return PhotoHTTPServer(predictor, metadata, port)


def serve_photo_test(manifest_dir: Path, run_dir: Path, checkpoint: str = "best", device: str = "auto", port: int = 8765) -> None:
    """Validate the saved model before listening; Ctrl+C stops the local server."""
    from .photo_inference import PhotoPredictor

    predictor = PhotoPredictor(manifest_dir, run_dir, checkpoint=checkpoint, device=device)
    server = create_photo_server(predictor, port=port)
    print(f"Local personal-photo test ready: {server.origin}", flush=True)
    print("Experimental saved model. Photos stay in memory; Ctrl+C stops this test.", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
