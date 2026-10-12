"""Real loopback HTTP contracts with a synthetic predictor; no customer photos."""

import hashlib
import http.client
import json
from pathlib import Path
import socket
import threading
import time

import pytest

from senmiva_training import photo_server
from senmiva_training.photo_inference import PhotoInputError


class FakePredictor:
    def __init__(self):
        self.calls = []
        self.error = None
        self.entered = None
        self.release = None

    def metadata(self):
        return {"experimental": True, "production_ready": False, "targets": ["pores"]}

    def predict_image(self, payload):
        self.calls.append({"length": len(payload), "sha256": hashlib.sha256(payload).hexdigest()})
        if self.entered:
            self.entered.set()
            assert self.release.wait(3)
        if self.error:
            raise self.error
        return {"experimental": True, "predictions": {"pores": {"code": "VP", "probability": 0.6}}}


@pytest.fixture
def running(tmp_path, monkeypatch):
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "index.html").write_text("<html>Local synthetic test</html>", encoding="utf-8")
    (assets / "app.js").write_text("window.synthetic = true;", encoding="utf-8")
    (assets / "style.css").write_text("body { color: black; }", encoding="utf-8")
    monkeypatch.setattr(photo_server, "ASSET_ROOT", assets)
    predictor = FakePredictor()
    server = photo_server.create_photo_server(predictor, port=0)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    yield server, predictor, assets
    if predictor.release:
        predictor.release.set()
    server.shutdown()
    server.server_close()
    thread.join(2)
    assert not thread.is_alive()


def request(server, method="GET", path="/api/model", body=None, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
    connection.request(method, path, body=body, headers=headers or {})
    response = connection.getresponse()
    payload = response.read()
    result = response.status, dict(response.getheaders()), payload
    connection.close()
    return result


def authenticated(server):
    status, _, body = request(server)
    assert status == 200
    metadata = json.loads(body)
    return {"Origin": metadata["origin"], "X-Senmiva-Token": metadata["csrf_token"], "Content-Type": "image/png"}


def raw_request(server, lines, body=b"", half_close=False):
    with socket.create_connection(("127.0.0.1", server.server_port), timeout=2) as stream:
        stream.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body)
        if half_close:
            stream.shutdown(socket.SHUT_WR)
        output = b""
        while True:
            chunk = stream.recv(65536)
            if not chunk:
                break
            output += chunk
    return output


def test_server_only_binds_loopback(running):
    server, _, _ = running
    assert server.server_address == ("127.0.0.1", server.server_port)
    assert server.origin == f"http://127.0.0.1:{server.server_port}"


def test_model_metadata_is_safe_and_per_process_token(running):
    server, predictor, _ = running
    status, headers, body = request(server)
    value = json.loads(body)
    assert status == 200
    assert value["experimental"] is True
    assert value["production_ready"] is False
    assert value["origin"] == server.origin
    assert len(value["csrf_token"]) >= 32
    assert predictor.calls == []
    assert "Access-Control-Allow-Origin" not in headers
    other = photo_server.create_photo_server(FakePredictor(), port=0)
    try:
        assert server.session_token != other.session_token
    finally:
        other.server_close()


@pytest.mark.parametrize("path,content_type", [("/", "text/html"), ("/app.js", "text/javascript"), ("/style.css", "text/css")])
def test_fixed_assets_and_security_headers(running, path, content_type):
    status, headers, body = request(running[0], path=path)
    assert status == 200
    assert body
    assert headers["Content-Type"].startswith(content_type)
    assert headers["Connection"] == "close"
    for key, value in photo_server.SECURITY_HEADERS.items():
        assert headers[key] == value
    assert "Access-Control-Allow-Origin" not in headers
    assert "Server" not in headers
    assert "unsafe-inline" not in headers["Content-Security-Policy"]
    assert "frame-ancestors 'none'" in headers["Content-Security-Policy"]


@pytest.mark.parametrize("path", ["/api/model?x=1", "/?x=1", "/../photo_inference.py", "/%2e%2e/workspace.py", "/favicon.ico", "http://example.com/"])
def test_routes_never_list_files_redirect_or_accept_queries(running, path):
    status, headers, body = request(running[0], path=path, headers={"Host": running[0].expected_host})
    assert status == 404
    assert "Location" not in headers
    assert path.encode() not in body


def test_valid_prediction_receives_only_raw_bytes_and_writes_nothing(running, monkeypatch):
    server, predictor, assets = running
    headers = authenticated(server)
    before = {item.name: item.read_bytes() for item in assets.iterdir()}

    def no_write(*args, **kwargs):
        raise AssertionError("The photo server must not write files.")

    monkeypatch.setattr(Path, "write_bytes", no_write)
    monkeypatch.setattr(Path, "write_text", no_write)
    payload = b"synthetic image bytes"
    status, response_headers, body = request(server, "POST", "/api/predict", payload, headers)
    assert status == 200
    assert json.loads(body)["experimental"] is True
    assert predictor.calls == [{"length": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}]
    assert before == {item.name: item.read_bytes() for item in assets.iterdir()}
    assert payload.decode() not in repr(server.__dict__)
    assert "Access-Control-Allow-Origin" not in response_headers


@pytest.mark.parametrize("headers", [{"Host": "localhost:1234"}, {"Host": "example.com"}, {"Origin": "null"}, {"Origin": "https://example.com"}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}])
def test_get_metadata_rejects_foreign_context(running, headers):
    status, _, _ = request(running[0], headers=headers)
    assert status == 403


@pytest.mark.parametrize("change", ["missing_origin", "foreign_origin", "null_origin", "missing_token", "wrong_token", "nonascii_token", "cross_site", "wrong_host"])
def test_post_requires_exact_origin_host_and_token(running, change):
    server, predictor, _ = running
    headers = authenticated(server)
    if change == "missing_origin":
        del headers["Origin"]
    elif change == "foreign_origin":
        headers["Origin"] = "http://127.0.0.1:1"
    elif change == "null_origin":
        headers["Origin"] = "null"
    elif change == "missing_token":
        del headers["X-Senmiva-Token"]
    elif change == "wrong_token":
        headers["X-Senmiva-Token"] = "wrong"
    elif change == "nonascii_token":
        headers["X-Senmiva-Token"] = "é"
    elif change == "cross_site":
        headers["Sec-Fetch-Site"] = "cross-site"
    elif change == "wrong_host":
        headers["Host"] = "localhost:" + str(server.server_port)
    status, response_headers, body = request(server, "POST", "/api/predict", b"image", headers)
    assert status == 403
    assert predictor.calls == []
    assert response_headers["Cache-Control"].startswith("no-store")
    assert server.session_token.encode() not in body


@pytest.mark.parametrize("extra,status", [
    (["Content-Length: 1", "Content-Length: 1"], 400),
    (["Content-Length: -1"], 400),
    (["Content-Length: +1"], 400),
    (["Content-Length: 1, 1"], 400),
    (["Content-Length: ١"], 400),
    (["Content-Length: 999999999999999999"], 400),
    (["Content-Length: 0"], 400),
    ([f"Content-Length: {photo_server.MAX_IMAGE_BYTES + 1}"], 413),
    (["Transfer-Encoding: chunked", "Content-Length: 1"], 400),
    (["Transfer-Encoding: identity", "Content-Length: 1"], 400),
    ([], 411),
])
def test_rejects_ambiguous_unbounded_and_oversize_framing(running, extra, status):
    server, predictor, _ = running
    lines = ["POST /api/predict HTTP/1.1", f"Host: {server.expected_host}", f"Origin: {server.origin}",
             f"X-Senmiva-Token: {server.session_token}", "Content-Type: image/png", *extra]
    # U+0661 cannot appear in an HTTP Latin-1 header; exercise the parser's raw high byte instead.
    lines = [line.replace("١", "¹") for line in lines]
    response = raw_request(server, lines)
    assert response.startswith(f"HTTP/1.1 {status} ".encode())
    assert b"Connection: close" in response
    assert predictor.calls == []


@pytest.mark.parametrize("name,value", [("Host", "127.0.0.1:1"), ("Origin", "null"), ("X-Senmiva-Token", "wrong"), ("Content-Type", "image/png"), ("Sec-Fetch-Site", "same-origin")])
def test_rejects_duplicate_security_headers(running, name, value):
    server, predictor, _ = running
    lines = ["POST /api/predict HTTP/1.1", f"Host: {server.expected_host}", f"Origin: {server.origin}",
             f"X-Senmiva-Token: {server.session_token}", "Content-Type: image/png", "Content-Length: 1",
             "Sec-Fetch-Site: same-origin", f"{name}: {value}"]
    response = raw_request(server, lines)
    expected = 415 if name == "Content-Type" else 403
    assert response.startswith(f"HTTP/1.1 {expected} ".encode())
    assert predictor.calls == []


@pytest.mark.parametrize("content_type", ["application/octet-stream", "multipart/form-data; boundary=x", "image/svg+xml", "image/gif", "image/png; x=y", "text/plain"])
def test_rejects_unsupported_media_types(running, content_type):
    server, predictor, _ = running
    headers = {**authenticated(server), "Content-Type": content_type}
    assert request(server, "POST", "/api/predict", b"image", headers)[0] == 415
    assert predictor.calls == []


@pytest.mark.parametrize("method", ["HEAD", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE"])
def test_unsupported_methods_do_not_leak_or_enable_cors(running, method):
    status, headers, body = request(running[0], method, "/api/model")
    assert status == 405
    assert "Access-Control-Allow-Origin" not in headers
    assert "Access-Control-Allow-Methods" not in headers
    assert headers["Cache-Control"].startswith("no-store")
    assert method.encode() not in body


def test_get_rejects_body_framing_and_expect_continue(running):
    server, predictor, _ = running
    assert request(server, headers={"Content-Length": "1"})[0] == 400
    assert request(server, headers={"Transfer-Encoding": "chunked"})[0] == 400
    lines = ["POST /api/predict HTTP/1.1", f"Host: {server.expected_host}", "Expect: 100-continue", "Content-Length: 1"]
    result = raw_request(server, lines)
    assert result.startswith(b"HTTP/1.1 417 ")
    assert b"100 Continue" not in result
    assert predictor.calls == []


def test_truncated_and_timed_out_body_do_not_reach_predictor(running, monkeypatch):
    server, predictor, _ = running
    lines = ["POST /api/predict HTTP/1.1", f"Host: {server.expected_host}", f"Origin: {server.origin}",
             f"X-Senmiva-Token: {server.session_token}", "Content-Type: image/png", "Content-Length: 10"]
    assert raw_request(server, lines, b"a", half_close=True).startswith(b"HTTP/1.1 400 ")
    monkeypatch.setattr(photo_server, "READ_TIMEOUT_SECONDS", 0.05)
    assert raw_request(server, lines, b"a").startswith(b"HTTP/1.1 408 ")
    assert predictor.calls == []


@pytest.mark.parametrize("error,status", [(PhotoInputError("private malformed image detail"), 400), (RuntimeError("private path and traceback detail"), 500)])
def test_errors_are_sanitized_unlogged_and_release_lock(running, capsys, error, status):
    server, predictor, _ = running
    predictor.error = error
    headers = authenticated(server)
    code, _, body = request(server, "POST", "/api/predict", b"sensitive synthetic payload", headers)
    assert code == status
    assert b"private" not in body
    assert b"sensitive" not in body
    predictor.error = None
    assert request(server, "POST", "/api/predict", b"image", headers)[0] == 200
    capture = capsys.readouterr()
    assert capture.out == ""
    assert capture.err == ""


def test_inference_is_nonblocking_serial_and_recovers(running):
    server, predictor, _ = running
    headers = authenticated(server)
    predictor.entered = threading.Event()
    predictor.release = threading.Event()
    first = []
    worker = threading.Thread(target=lambda: first.append(request(server, "POST", "/api/predict", b"first", headers)))
    worker.start()
    assert predictor.entered.wait(2)
    started = time.monotonic()
    assert request(server, "POST", "/api/predict", b"second", headers)[0] == 429
    assert time.monotonic() - started < 1
    assert len(predictor.calls) == 1
    predictor.release.set()
    worker.join(2)
    assert first[0][0] == 200
    predictor.entered = None
    assert request(server, "POST", "/api/predict", b"third", headers)[0] == 200


def test_connection_work_is_bounded_without_a_waiting_thread_queue(running):
    server, predictor, _ = running
    streams = []
    try:
        for _ in range(photo_server.MAX_CONNECTIONS):
            stream = socket.create_connection(("127.0.0.1", server.server_port), timeout=2)
            stream.sendall(b"GET /api/model HTTP/1.1\r\n")
            streams.append(stream)
        deadline = time.monotonic() + 2
        while server.connection_slots._value and time.monotonic() < deadline:
            time.sleep(0.01)
        assert server.connection_slots._value == 0
        assert request(server)[0] == 429
        assert predictor.calls == []
    finally:
        for stream in streams:
            stream.close()


@pytest.mark.parametrize("port", [-1, 65536, True, "8765", None])
def test_invalid_port_never_listens(port):
    with pytest.raises(ValueError, match="valid local port"):
        photo_server.create_photo_server(FakePredictor(), port=port)


def test_missing_assets_fail_closed_without_exposing_paths(running):
    server, _, assets = running
    (assets / "app.js").unlink()
    status, _, body = request(server, path="/app.js")
    assert status == 503
    assert str(assets).encode() not in body


def test_serve_validates_predictor_before_binding_and_sanitizes_console(monkeypatch, capsys, tmp_path):
    from senmiva_training import photo_inference

    events = []

    class ReadyServer:
        origin = "http://127.0.0.1:8765"

        def serve_forever(self, **kwargs):
            events.append("serve")
            raise KeyboardInterrupt

        def server_close(self):
            events.append("close")

    def predictor(*args, **kwargs):
        events.append("validated")
        return FakePredictor()

    def create(*args, **kwargs):
        assert events == ["validated"]
        events.append("listen")
        return ReadyServer()

    monkeypatch.setattr(photo_inference, "PhotoPredictor", predictor)
    monkeypatch.setattr(photo_server, "create_photo_server", create)
    photo_server.serve_photo_test(tmp_path / "private-manifest", tmp_path / "private-run")
    assert events == ["validated", "listen", "serve", "close"]
    console = capsys.readouterr()
    assert "http://127.0.0.1:8765" in console.out
    assert "private" not in console.out
    assert console.err == ""


def test_failed_predictor_never_opens_port(monkeypatch, tmp_path):
    from senmiva_training import photo_inference

    def failure(*args, **kwargs):
        raise ValueError("Invalid saved checkpoint.")

    def no_listen(*args, **kwargs):
        raise AssertionError("An unverified model must not listen.")

    monkeypatch.setattr(photo_inference, "PhotoPredictor", failure)
    monkeypatch.setattr(photo_server, "create_photo_server", no_listen)
    with pytest.raises(ValueError, match="Invalid saved checkpoint"):
        photo_server.serve_photo_test(tmp_path, tmp_path)
