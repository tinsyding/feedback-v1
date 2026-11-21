#!/usr/bin/env python3
"""Differential parity test harness for feedback-v1 PHP API vs Go backend.

Uses Python 3 stdlib only. Spins up an isolated temporary feedback-v1 root,
an in-process mock OpenAI-compatible Vision API server, PHP built-in server
(`php -S`), and optionally the compiled Go `feedback-api` binary.
"""

from __future__ import annotations

import argparse
import base64
import datetime
import http.server
import json
import math
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


DEFAULT_SENDER_TOKEN = "jf_feedback_sender_internal_token_2026"
TEST_SENDER_TOKEN = "test_sender_token_parity_2026"
TEST_VISION_KEY = "sk-parity-secret-key"
TEST_RETEST_SECRET = "test_retest_secret_parity_2026"

ALLOWED_ORIGIN_EXACT = {
    "http://localhost",
    "http://127.0.0.1",
    "https://feedback.wxjifang.cn",
    "https://vip.wxjifang.cn",
    "https://vip.jokerx.top",
}
ALLOWED_ORIGIN_RE = re.compile(r"^https?://([a-zA-Z0-9-]+\.)*wxjifang\.cn(:\d+)?$")

ARCHIVE_DIR_RE = re.compile(r"^\d{6}_(full|title|reply|sidebar)_[0-9a-f]{8}$")
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
SHANGHAI_TZ = datetime.timezone(datetime.timedelta(hours=8))


def make_png(width: int, height: int, rgb: tuple[int, int, int] = (32, 96, 160)) -> bytes:
    """Generate a valid RGB PNG image in memory using stdlib zlib + struct."""
    if width <= 0 or height <= 0:
        raise ValueError("PNG dimensions must be positive")

    def chunk(chunk_type: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + chunk_type + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    pixel = bytes(rgb)
    scanline = b"\x00" + (pixel * width)
    raw_pixels = scanline * height
    idat = zlib.compress(raw_pixels, level=1)
    return PNG_MAGIC + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def make_jpeg(width: int, height: int) -> bytes:
    """Generate a minimal valid baseline JPEG (SOI + APP0/JFIF + SOF0 + EOI) for getimagesize & image.DecodeConfig."""
    if width <= 0 or height <= 0:
        raise ValueError("JPEG dimensions must be positive")
    app0 = b"\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    sof0_payload = struct.pack(">BHHB", 8, height, width, 3) + b"\x01\x22\x00\x02\x11\x01\x03\x11\x01"
    sof0 = b"\xff\xc0" + struct.pack(">H", len(sof0_payload) + 2) + sof0_payload
    return b"\xff\xd8" + app0 + sof0 + b"\xff\xd9"


PNG_10X10 = make_png(10, 10, (120, 40, 40))
PNG_400X300 = make_png(400, 300, (40, 120, 180))
JPEG_400X300 = make_jpeg(400, 300)
INVALID_TEXT_BYTES = b"this is definitely not a PNG or JPEG image\n"


def encode_multipart(
    fields: dict[str, str] | None = None,
    files: list[tuple[str, str, str, bytes]] | None = None,
) -> tuple[bytes, str]:
    """Encode fields and binary files into multipart/form-data payload."""
    boundary = f"----ParityBoundary{uuid.uuid4().hex}"
    parts: list[bytes] = []

    for name, value in (fields or {}).items():
        parts.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                f"{value}\r\n"
            ).encode("utf-8")
        )

    for field_name, filename, content_type, data in (files or []):
        header = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n"
        ).encode("utf-8")
        parts.append(header + data + b"\r\n")

    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(parts)
    return body, f"multipart/form-data; boundary={boundary}"


@dataclass
class HttpResponse:
    status: int
    headers: dict[str, str]
    body: bytes

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))


_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http_request(
    base_url: str,
    method: str,
    path: str,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = 15.0,
) -> HttpResponse:
    """Send an HTTP request without proxy interference and capture non-2xx responses."""
    url = base_url.rstrip("/") + path
    req_headers = {"Connection": "close"}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, data=body, headers=req_headers, method=method.upper())
    try:
        with _NO_PROXY_OPENER.open(req, timeout=timeout) as resp:
            hdrs = {k.lower(): v for k, v in resp.headers.items()}
            return HttpResponse(status=resp.status, headers=hdrs, body=resp.read())
    except urllib.error.HTTPError as err:
        hdrs = {k.lower(): v for k, v in err.headers.items()} if err.headers else {}
        return HttpResponse(status=err.code, headers=hdrs, body=err.read())


@dataclass
class RecordedVisionRequest:
    path: str
    headers: dict[str, str]
    authorization: str
    body_json: Any


class MockVisionState:
    """Thread-safe configurable response & request recorder for mock Vision API."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.status_code: int = 200
        self.response_body: bytes = b"{}"
        self.requests: list[RecordedVisionRequest] = []

    def set_chat_content(self, content: str, status_code: int = 200) -> None:
        payload = {
            "id": "mock-chatcmpl-1",
            "object": "chat.completion",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": content,
                    },
                    "finish_reason": "stop",
                }
            ],
        }
        self.set_json(status_code, payload)

    def set_json(self, status_code: int, obj: Any) -> None:
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.set_raw(status_code, raw)

    def set_raw(self, status_code: int, raw_bytes: bytes) -> None:
        with self._lock:
            self.status_code = status_code
            self.response_body = raw_bytes

    def record(self, req: RecordedVisionRequest) -> tuple[int, bytes]:
        with self._lock:
            self.requests.append(req)
            return self.status_code, self.response_body

    def snapshot_count(self) -> int:
        with self._lock:
            return len(self.requests)

    def slice_since(self, index: int) -> list[RecordedVisionRequest]:
        with self._lock:
            return list(self.requests[index:])


class _MockVisionHandler(http.server.BaseHTTPRequestHandler):
    state: MockVisionState

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            body_json = json.loads(raw.decode("utf-8")) if raw else None
        except Exception:
            body_json = None

        hdrs = {k.lower(): v for k, v in self.headers.items()}
        rec = RecordedVisionRequest(
            path=self.path,
            headers=hdrs,
            authorization=self.headers.get("Authorization", ""),
            body_json=body_json,
        )
        status, resp_bytes = self.state.record(rec)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(resp_bytes)))
        self.end_headers()
        self.wfile.write(resp_bytes)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return


class MockVisionServer:
    def __init__(self) -> None:
        self.state = MockVisionState()
        handler_cls = type(
            "BoundMockVisionHandler",
            (_MockVisionHandler,),
            {"state": self.state},
        )
        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        self.port = self._httpd.server_address[1]
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=3)


def alloc_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def clean_subprocess_env() -> dict[str, str]:
    env = os.environ.copy()
    for key in (
        "SENDER_API_TOKEN",
        "SENDER_API_TOKENS",
        "ALLOW_DEFAULT_SENDER_TOKEN",
        "DASHSCOPE_API_KEY",
        "IDENTIFY_API_BASE",
        "IDENTIFY_MODEL",
        "IDENTIFY_FAST_MODEL",
        "RETEST_SECRET",
        "FEEDBACK_ENV_FILE",
        "FEEDBACK_SECRETS_FILE",
        "FEEDBACK_ROOT",
        "FEEDBACK_LISTEN_ADDR",
        "DB_HOST",
        "DB_PORT",
        "DB_DATABASE",
        "DB_USERNAME",
        "DB_PASSWORD",
    ):
        env.pop(key, None)
    env["ALLOW_DEFAULT_SENDER_TOKEN"] = "false"
    return env


def wait_for_server(
    proc: subprocess.Popen[bytes],
    log_path: Path,
    base_url: str,
    probe_path: str,
    name: str,
    timeout_s: float = 10.0,
) -> None:
    deadline = time.monotonic() + timeout_s
    last_err = ""
    while time.monotonic() < deadline:
        rc = proc.poll()
        if rc is not None:
            log_text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.is_file() else ""
            raise RuntimeError(f"{name} exited prematurely (code={rc}).\nlog:\n{log_text}")
        try:
            resp = http_request(base_url, "GET", probe_path, timeout=1.5)
            if resp.status == 200:
                return
            last_err = f"HTTP {resp.status}: {resp.text}"
        except Exception as exc:
            last_err = str(exc)
        time.sleep(0.08)
    log_text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.is_file() else ""
    raise RuntimeError(f"{name} failed readiness probe {probe_path} within {timeout_s}s: {last_err}\nlog:\n{log_text}")


def stop_process(proc: subprocess.Popen[bytes] | None) -> None:
    if proc is None:
        return
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)


def is_allowed_origin(origin: str) -> bool:
    if not origin:
        return False
    if origin in ALLOWED_ORIGIN_EXACT:
        return True
    return bool(ALLOWED_ORIGIN_RE.match(origin))


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def assert_eq(actual: Any, expected: Any, msg: str) -> None:
    if type(actual) is bool or type(expected) is bool:
        if type(actual) is not type(expected) or actual != expected:
            raise AssertionError(f"{msg}: expected {expected!r} ({type(expected).__name__}), got {actual!r} ({type(actual).__name__})")
        return
    if actual != expected:
        raise AssertionError(f"{msg}: expected {expected!r}, got {actual!r}")


def assert_cors_headers(engine: str, origin: str | None, resp: HttpResponse) -> None:
    hdrs = resp.headers
    assert_eq(
        hdrs.get("access-control-allow-methods"),
        "GET, POST, DELETE, OPTIONS",
        f"[{engine}] Access-Control-Allow-Methods",
    )
    assert_eq(
        hdrs.get("access-control-allow-headers"),
        "Content-Type, Authorization, X-Requested-With",
        f"[{engine}] Access-Control-Allow-Headers",
    )
    if origin and is_allowed_origin(origin):
        assert_eq(
            hdrs.get("access-control-allow-origin"),
            origin,
            f"[{engine}] Access-Control-Allow-Origin for allowed origin {origin}",
        )
        assert_eq(
            hdrs.get("access-control-allow-credentials"),
            "true",
            f"[{engine}] Access-Control-Allow-Credentials for allowed origin {origin}",
        )
    else:
        assert_true(
            "access-control-allow-origin" not in hdrs,
            f"[{engine}] unexpected Access-Control-Allow-Origin={hdrs.get('access-control-allow-origin')!r} for origin={origin!r}",
        )
        assert_true(
            "access-control-allow-credentials" not in hdrs,
            f"[{engine}] unexpected Access-Control-Allow-Credentials for origin={origin!r}",
        )


def assert_json_values_match(
    a: Any,
    b: Any,
    ctx: str,
    path: str = "$",
    float_array_paths: set[str] | None = None,
) -> None:
    """Strict structural + type-safe JSON equality (ignoring exact duration_ms int and live server_time second)."""
    if path == "$.data.duration_ms":
        for label, val in (("left", a), ("right", b)):
            assert_true(
                type(val) is int and val >= 0,
                f"{ctx} {path} ({label}) must be non-negative int, got {val!r} ({type(val).__name__})",
            )
        return

    if path == "$.data.cloud_control.server_time":
        for label, val in (("left", a), ("right", b)):
            assert_true(
                isinstance(val, str) and bool(re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$", val)),
                f"{ctx} {path} ({label}) must be YYYY-MM-DD HH:MM:SS string, got {val!r}",
            )
        return

    if float_array_paths and path in float_array_paths:
        assert_true(isinstance(a, list) and isinstance(b, list), f"{ctx} {path}: both must be lists")
        assert_eq(len(a), len(b), f"{ctx} {path} length")
        for idx, (va, vb) in enumerate(zip(a, b)):
            assert_true(
                type(va) in (int, float) and type(vb) in (int, float),
                f"{ctx} {path}[{idx}]: expected numeric, got {va!r} vs {vb!r}",
            )
            assert_true(
                math.isclose(float(va), float(vb), abs_tol=1e-9),
                f"{ctx} {path}[{idx}]: float mismatch {va!r} != {vb!r}",
            )
        return

    if type(a) is bool or type(b) is bool:
        assert_eq(a, b, f"{ctx} {path}")
        return

    if isinstance(a, dict) and isinstance(b, dict):
        assert_eq(set(a.keys()), set(b.keys()), f"{ctx} {path} keys")
        for k in sorted(a.keys()):
            assert_json_values_match(a[k], b[k], ctx, f"{path}.{k}", float_array_paths)
        return

    if isinstance(a, list) and isinstance(b, list):
        assert_eq(len(a), len(b), f"{ctx} {path} len")
        for idx, (va, vb) in enumerate(zip(a, b)):
            assert_json_values_match(va, vb, ctx, f"{path}[{idx}]", float_array_paths)
        return

    if type(a) is not type(b):
        raise AssertionError(
            f"{ctx} {path}: type mismatch {a!r} ({type(a).__name__}) vs {b!r} ({type(b).__name__})"
        )
    assert_eq(a, b, f"{ctx} {path}")


def assert_response_parity(
    test_name: str,
    php_resp: HttpResponse,
    go_resp: HttpResponse,
    *,
    origin: str | None = None,
    check_cache_control: bool = False,
    float_array_paths: set[str] | None = None,
    expect_json: bool = True,
) -> None:
    assert_eq(go_resp.status, php_resp.status, f"[{test_name}] PHP vs Go HTTP status")
    assert_cors_headers("php-parity", origin, php_resp)
    assert_cors_headers("go-parity", origin, go_resp)

    if check_cache_control:
        assert_eq(
            go_resp.headers.get("cache-control"),
            php_resp.headers.get("cache-control"),
            f"[{test_name}] PHP vs Go Cache-Control",
        )

    if php_resp.status == 204:
        assert_eq(go_resp.body, b"", f"[{test_name}] Go 204 body empty")
        assert_eq(php_resp.body, b"", f"[{test_name}] PHP 204 body empty")
        return

    if not expect_json:
        return

    php_ct = php_resp.headers.get("content-type", "").lower()
    go_ct = go_resp.headers.get("content-type", "").lower()
    assert_true("application/json" in php_ct, f"[{test_name}] PHP Content-Type not JSON: {php_ct!r}")
    assert_true("application/json" in go_ct, f"[{test_name}] Go Content-Type not JSON: {go_ct!r}")

    php_json = php_resp.json()
    go_json = go_resp.json()
    assert_json_values_match(
        php_json,
        go_json,
        f"[{test_name}] PHP vs Go JSON",
        float_array_paths=float_array_paths,
    )


class ParityHarness:
    def __init__(self, feedback_root: Path, mock: MockVisionServer, php_url: str, go_url: str | None) -> None:
        self.feedback_root = feedback_root
        self.mock = mock
        self.engines: list[tuple[str, str]] = [("php", php_url)]
        if go_url:
            self.engines.append(("go", go_url))
        self.results: list[tuple[str, bool, str]] = []

    def write_config(self, cfg: dict[str, Any] | None) -> None:
        cfg_path = self.feedback_root / "config.json"
        if cfg is None:
            if cfg_path.exists():
                cfg_path.unlink()
            return
        tmp_path = self.feedback_root / f".config.{uuid.uuid4().hex}.tmp"
        tmp_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp_path, cfg_path)

    def baseline_config(self, **overrides: Any) -> dict[str, Any]:
        cfg: dict[str, Any] = {
            "semesterYear": 2026,
            "defaultSeason": "autumn",
            "semesterWeeks": 18,
            "forceIntegerScores": True,
            "retestQuestionSpacing": 26,
            "retestQrCodeEnabled": False,
            "disableQwenFlashTitle": False,
            "senderControl": {
                "policyVersion": 1,
                "senderServiceEnabled": True,
                "enableAutoCalibration": True,
                "verifyMode": "auto",
                "enableReplyAnalysis": True,
                "enableBenchmarkModel": True,
                "snapshotPolicy": "errors_only",
            },
            "dashscopeApiKey": "",
            "identifyApiBase": "",
            "calibrateModel": "mock-calibrate-max",
            "identifyFastModel": "mock-vision-flash",
            "identifyModel": "mock-vision-max",
            "benchmarkModel": "mock-benchmark-model",
        }
        cfg.update(overrides)
        return cfg

    def archive_day_dir(self) -> Path:
        ymd = datetime.datetime.now(SHANGHAI_TZ).strftime("%Y%m%d")
        return self.feedback_root / "data" / "identify_archive" / ymd

    def snapshot_archive_subdirs(self) -> set[str]:
        day_dir = self.archive_day_dir()
        if not day_dir.is_dir():
            return set()
        return {p.name for p in day_dir.iterdir() if p.is_dir()}

    def run_test(self, name: str, fn: Callable[[], None]) -> None:
        try:
            fn()
            self.results.append((name, True, "PASS"))
            print(f"[PASS] {name}")
        except Exception as exc:
            self.results.append((name, False, f"{type(exc).__name__}: {exc}"))
            print(f"[FAIL] {name}: {exc}")

    def execute_across_engines(
        self,
        test_name: str,
        make_req: Callable[[str], HttpResponse],
        assert_engine: Callable[[str, HttpResponse, list[RecordedVisionRequest], set[str]], None],
        *,
        origin: str | None = None,
        check_cache_control: bool = False,
        float_array_paths: set[str] | None = None,
        expect_json: bool = True,
    ) -> dict[str, HttpResponse]:
        responses: dict[str, HttpResponse] = {}
        mock_calls_by_engine: dict[str, list[RecordedVisionRequest]] = {}

        for engine, base_url in self.engines:
            mock_before = self.mock.state.snapshot_count()
            archive_before = self.snapshot_archive_subdirs()
            resp = make_req(base_url)
            mock_calls = self.mock.state.slice_since(mock_before)
            archive_after = self.snapshot_archive_subdirs()
            new_archives = archive_after - archive_before

            assert_engine(engine, resp, mock_calls, new_archives)
            responses[engine] = resp
            mock_calls_by_engine[engine] = mock_calls

        if "php" in responses and "go" in responses:
            assert_response_parity(
                test_name,
                responses["php"],
                responses["go"],
                origin=origin,
                check_cache_control=check_cache_control,
                float_array_paths=float_array_paths,
                expect_json=expect_json,
            )
            php_calls = mock_calls_by_engine["php"]
            go_calls = mock_calls_by_engine["go"]
            assert_eq(len(go_calls), len(php_calls), f"[{test_name}] mock Vision API call count")
            for idx, (pc, gc) in enumerate(zip(php_calls, go_calls)):
                assert_eq(gc.path, pc.path, f"[{test_name}] mock call[{idx}] path")
                assert_eq(gc.authorization, pc.authorization, f"[{test_name}] mock call[{idx}] Authorization")
                assert_true(
                    isinstance(pc.body_json, dict) and isinstance(gc.body_json, dict),
                    f"[{test_name}] mock call[{idx}] JSON body",
                )
                assert_eq(gc.body_json.get("model"), pc.body_json.get("model"), f"[{test_name}] mock call[{idx}] model")
                assert_eq(
                    float(gc.body_json.get("temperature", -1)),
                    float(pc.body_json.get("temperature", -2)),
                    f"[{test_name}] mock call[{idx}] temperature",
                )
        return responses


def verify_archive_entry(
    harness: ParityHarness,
    engine: str,
    new_archives: set[str],
    *,
    expected_mode: str,
    expected_target_id: str,
    expected_target_name: str,
    expected_detected_title: str,
    expected_model: str,
    expected_pngs: list[str],
    forbidden_pngs: list[str],
    expected_raw_content: str,
    expected_mapped: dict[str, Any],
) -> None:
    assert_eq(len(new_archives), 1, f"[{engine}] new identify_archive dir count")
    dirname = next(iter(new_archives))
    assert_true(bool(ARCHIVE_DIR_RE.match(dirname)), f"[{engine}] archive dir name {dirname!r} invalid")
    assert_true(f"_{expected_mode}_" in dirname, f"[{engine}] archive dir {dirname!r} missing mode {expected_mode}")

    entry_dir = harness.archive_day_dir() / dirname
    req_path = entry_dir / "request.json"
    resp_path = entry_dir / "response.json"
    assert_true(req_path.is_file(), f"[{engine}] missing request.json in {entry_dir}")
    assert_true(resp_path.is_file(), f"[{engine}] missing response.json in {entry_dir}")

    req_json = json.loads(req_path.read_text(encoding="utf-8"))
    expected_req_keys = {"mode", "target_id", "target_name", "detected_title", "model", "ip", "time"}
    assert_eq(set(req_json.keys()), expected_req_keys, f"[{engine}] request.json keys")
    assert_eq(req_json["mode"], expected_mode, f"[{engine}] request.json mode")
    assert_eq(req_json["target_id"], expected_target_id, f"[{engine}] request.json target_id")
    assert_eq(req_json["target_name"], expected_target_name, f"[{engine}] request.json target_name")
    assert_eq(req_json["detected_title"], expected_detected_title, f"[{engine}] request.json detected_title")
    assert_eq(req_json["model"], expected_model, f"[{engine}] request.json model")
    assert_true(isinstance(req_json["ip"], str) and len(req_json["ip"]) > 0, f"[{engine}] request.json ip")
    assert_true(
        bool(re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$", str(req_json["time"]))),
        f"[{engine}] request.json time format: {req_json['time']!r}",
    )

    resp_json = json.loads(resp_path.read_text(encoding="utf-8"))
    assert_eq(set(resp_json.keys()), {"mapped", "raw_content"}, f"[{engine}] response.json keys")
    assert_eq(resp_json["raw_content"], expected_raw_content, f"[{engine}] response.json raw_content")
    assert_json_values_match(
        {"data": expected_mapped},
        {"data": resp_json["mapped"]},
        f"[{engine}] response.json mapped",
    )

    for png_name in expected_pngs:
        p = entry_dir / png_name
        assert_true(p.is_file(), f"[{engine}] missing archive image {png_name} in {entry_dir}")
        data = p.read_bytes()
        assert_true(data.startswith(PNG_MAGIC), f"[{engine}] archived {png_name} is not valid PNG")

    for png_name in forbidden_pngs:
        assert_true(
            not (entry_dir / png_name).exists(),
            f"[{engine}] unexpected archive image {png_name} for mode={expected_mode}",
        )


def register_and_run_all_tests(harness: ParityHarness) -> None:
    mock_port = harness.mock.port

    # 1. GET /api/public_config.php defaults (config.json absent)
    def test_public_config_defaults() -> None:
        harness.write_config(None)
        expected = {
            "success": True,
            "semesterYear": 2026,
            "defaultSeason": "autumn",
            "semesterWeeks": 18,
            "forceIntegerScores": True,
            "retestQuestionSpacing": 26,
            "retestQrCodeEnabled": False,
            "disableQwenFlashTitle": False,
        }

        def check(engine: str, resp: HttpResponse, mock_calls: list[RecordedVisionRequest], _: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] status")
            assert_eq(len(mock_calls), 0, f"[{engine}] no mock calls")
            assert_cors_headers(engine, None, resp)
            assert_eq(resp.headers.get("cache-control"), "public, max-age=300", f"[{engine}] Cache-Control")
            assert_true("application/json" in resp.headers.get("content-type", "").lower(), f"[{engine}] Content-Type")
            assert_json_values_match(expected, resp.json(), f"[{engine}] public_config defaults")

        harness.execute_across_engines(
            "public_config_defaults",
            lambda u: http_request(u, "GET", "/api/public_config.php"),
            check,
            check_cache_control=True,
        )

    # 2. GET /api/public_config.php clamped values + zero secret leakage
    def test_public_config_clamped_and_no_secrets() -> None:
        harness.write_config(
            {
                "_comment": "parity test comment",
                "semesterYear": 2026,
                "defaultSeason": "autumn",
                "semesterWeeks": 99,
                "forceIntegerScores": True,
                "retestQuestionSpacing": 5,
                "retestQrCodeEnabled": False,
                "disableQwenFlashTitle": False,
                "dashscopeApiKey": "sk-must-not-leak-in-public-config",
                "retestSecret": "retest-must-not-leak",
                "senderApiToken": "sender-token-must-not-leak",
                "identifyApiBase": f"http://127.0.0.1:{mock_port}/v1",
                "senderControl": {"enableAutoCalibration": True},
            }
        )
        expected = {
            "success": True,
            "semesterYear": 2026,
            "defaultSeason": "autumn",
            "semesterWeeks": 30,
            "forceIntegerScores": True,
            "retestQuestionSpacing": 10,
            "retestQrCodeEnabled": False,
            "disableQwenFlashTitle": False,
        }
        origin = "https://feedback.wxjifang.cn"

        def check(engine: str, resp: HttpResponse, _: list[RecordedVisionRequest], __: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] status")
            assert_cors_headers(engine, origin, resp)
            assert_eq(resp.headers.get("cache-control"), "public, max-age=300", f"[{engine}] Cache-Control")
            body = resp.json()
            assert_json_values_match(expected, body, f"[{engine}] public_config clamped")
            for forbidden in (
                "dashscopeApiKey",
                "retestSecret",
                "senderApiToken",
                "senderControl",
                "identifyApiBase",
                "sk-must-not-leak-in-public-config",
                "retest-must-not-leak",
                "sender-token-must-not-leak",
            ):
                assert_true(forbidden not in resp.text, f"[{engine}] leaked secret/internal {forbidden!r}")

        harness.execute_across_engines(
            "public_config_clamped_and_no_secrets",
            lambda u: http_request(u, "GET", "/api/public_config.php", headers={"Origin": origin}),
            check,
            origin=origin,
            check_cache_control=True,
        )

    # 3. Live dynamic config.json update without restarting server
    def test_public_config_live_update() -> None:
        harness.write_config(
            {
                "semesterYear": 2028,
                "defaultSeason": "spring",
                "semesterWeeks": 0,
                "forceIntegerScores": False,
                "retestQuestionSpacing": 999,
                "retestQrCodeEnabled": True,
                "disableQwenFlashTitle": True,
            }
        )
        expected = {
            "success": True,
            "semesterYear": 2028,
            "defaultSeason": "spring",
            "semesterWeeks": 1,
            "forceIntegerScores": False,
            "retestQuestionSpacing": 260,
            "retestQrCodeEnabled": True,
            "disableQwenFlashTitle": True,
        }

        def check(engine: str, resp: HttpResponse, _: list[RecordedVisionRequest], __: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] status")
            assert_eq(resp.headers.get("cache-control"), "public, max-age=300", f"[{engine}] Cache-Control")
            assert_json_values_match(expected, resp.json(), f"[{engine}] public_config live update")

        harness.execute_across_engines(
            "public_config_live_update",
            lambda u: http_request(u, "GET", "/api/public_config.php"),
            check,
            check_cache_control=True,
        )

    # 4-6. OPTIONS /api/public_config.php with allowed & disallowed Origins
    def make_options_test(origin: str) -> Callable[[], None]:
        def _test() -> None:
            def check(engine: str, resp: HttpResponse, _: list[RecordedVisionRequest], __: set[str]) -> None:
                assert_eq(resp.status, 204, f"[{engine}] OPTIONS status")
                assert_eq(resp.body, b"", f"[{engine}] OPTIONS empty body")
                assert_cors_headers(engine, origin, resp)

            harness.execute_across_engines(
                f"options_cors_{origin}",
                lambda u: http_request(u, "OPTIONS", "/api/public_config.php", headers={"Origin": origin}),
                check,
                origin=origin,
            )

        return _test

    # Reset baseline config before calibrate_roi & identify tests
    def reset_baseline() -> None:
        harness.write_config(harness.baseline_config())

    # 7. POST /api/calibrate_roi.php disallowed Origin CSRF -> 403
    def test_calibrate_csrf_origin_mismatch() -> None:
        reset_baseline()
        origin = "https://evil.example"
        expected = {"success": False, "data": None, "error": "非法跨站请求 (CSRF Origin Mismatch)"}

        def check(engine: str, resp: HttpResponse, mock_calls: list[RecordedVisionRequest], _: set[str]) -> None:
            assert_eq(resp.status, 403, f"[{engine}] status")
            assert_eq(len(mock_calls), 0, f"[{engine}] mock calls")
            assert_cors_headers(engine, origin, resp)
            assert_json_values_match(expected, resp.json(), f"[{engine}] CSRF Origin Mismatch")

        harness.execute_across_engines(
            "calibrate_csrf_origin_mismatch",
            lambda u: http_request(u, "POST", "/api/calibrate_roi.php", headers={"Origin": origin}),
            check,
            origin=origin,
        )

    # 8. POST /api/calibrate_roi.php disallowed Referer CSRF -> 403
    def test_calibrate_csrf_referer_mismatch() -> None:
        expected = {"success": False, "data": None, "error": "非法跨站请求 (CSRF Origin Mismatch)"}

        def check(engine: str, resp: HttpResponse, _: list[RecordedVisionRequest], __: set[str]) -> None:
            assert_eq(resp.status, 403, f"[{engine}] status")
            assert_json_values_match(expected, resp.json(), f"[{engine}] CSRF Referer Mismatch")

        harness.execute_across_engines(
            "calibrate_csrf_referer_mismatch",
            lambda u: http_request(
                u,
                "POST",
                "/api/calibrate_roi.php",
                headers={"Referer": "https://evil.example/form.html"},
            ),
            check,
        )

    # 9. GET /api/calibrate_roi.php readiness probe
    def test_calibrate_get_ready() -> None:
        expected = {"success": True, "data": {"service": "calibrate_roi", "status": "ready"}, "error": "ok"}

        def check(engine: str, resp: HttpResponse, _: list[RecordedVisionRequest], __: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] status")
            assert_json_values_match(expected, resp.json(), f"[{engine}] calibrate GET")

        harness.execute_across_engines(
            "calibrate_get_ready",
            lambda u: http_request(u, "GET", "/api/calibrate_roi.php"),
            check,
        )

    # 10. DELETE /api/calibrate_roi.php -> 405
    def test_calibrate_delete_405() -> None:
        expected = {"success": False, "data": None, "error": "仅支持 POST"}

        def check(engine: str, resp: HttpResponse, _: list[RecordedVisionRequest], __: set[str]) -> None:
            assert_eq(resp.status, 405, f"[{engine}] status")
            assert_json_values_match(expected, resp.json(), f"[{engine}] calibrate DELETE")

        harness.execute_across_engines(
            "calibrate_delete_405",
            lambda u: http_request(u, "DELETE", "/api/calibrate_roi.php"),
            check,
        )

    # 11. POST /api/calibrate_roi.php bad/empty/default token -> 200 鉴权失败
    def test_calibrate_bad_tokens() -> None:
        expected = {"success": False, "data": None, "error": "鉴权失败"}
        for case_label, fields, hdrs in [
            ("wrong_form_token", {"token": "wrong-token"}, {}),
            ("default_token_blocked_when_custom_set", {"token": DEFAULT_SENDER_TOKEN}, {}),
            ("empty_token", {}, {}),
        ]:
            def check(engine: str, resp: HttpResponse, mock_calls: list[RecordedVisionRequest], _: set[str], lbl=case_label) -> None:
                assert_eq(resp.status, 200, f"[{engine}:{lbl}] status")
                assert_eq(len(mock_calls), 0, f"[{engine}:{lbl}] mock calls")
                assert_json_values_match(expected, resp.json(), f"[{engine}:{lbl}]")

            body, ct = encode_multipart(fields=fields)
            req_hdrs = {"Content-Type": ct, **hdrs}
            harness.execute_across_engines(
                f"calibrate_{case_label}",
                lambda u, b=body, h=req_hdrs: http_request(u, "POST", "/api/calibrate_roi.php", headers=h, body=b),
                check,
            )

    # 12. Bearer header auth works & missing image -> 400
    def test_calibrate_bearer_auth_and_missing_image() -> None:
        expected = {"success": False, "data": None, "error": "缺少上传整窗截图：image"}
        for hdr_val in (f"Bearer {TEST_SENDER_TOKEN}", f"bearer {TEST_SENDER_TOKEN}"):
            body, ct = encode_multipart(fields={})

            def check(engine: str, resp: HttpResponse, _: list[RecordedVisionRequest], __: set[str]) -> None:
                assert_eq(resp.status, 400, f"[{engine}] status")
                assert_json_values_match(expected, resp.json(), f"[{engine}] missing image")

            harness.execute_across_engines(
                f"calibrate_bearer_missing_image_{hdr_val.split()[0]}",
                lambda u, b=body, c=ct, av=hdr_val: http_request(
                    u,
                    "POST",
                    "/api/calibrate_roi.php",
                    headers={"Content-Type": c, "Authorization": av},
                    body=b,
                ),
                check,
            )

    # 13. Non-image file -> 400
    def test_calibrate_non_image_400() -> None:
        expected = {"success": False, "data": None, "error": "只支持 PNG/JPEG 截图"}
        body, ct = encode_multipart(
            fields={"token": TEST_SENDER_TOKEN},
            files=[("image", "not-an-image.txt", "text/plain", INVALID_TEXT_BYTES)],
        )

        def check(engine: str, resp: HttpResponse, _: list[RecordedVisionRequest], __: set[str]) -> None:
            assert_eq(resp.status, 400, f"[{engine}] status")
            assert_json_values_match(expected, resp.json(), f"[{engine}] non-image")

        harness.execute_across_engines(
            "calibrate_non_image_400",
            lambda u: http_request(u, "POST", "/api/calibrate_roi.php", headers={"Content-Type": ct}, body=body),
            check,
        )

    # 14. 10x10 PNG (<300x200) -> 200
    def test_calibrate_small_10x10_200() -> None:
        expected = {"success": False, "data": None, "error": "截图尺寸过小，无法进行界面分析"}
        body, ct = encode_multipart(
            fields={"token": TEST_SENDER_TOKEN},
            files=[("image", "small.png", "image/png", PNG_10X10)],
        )

        def check(engine: str, resp: HttpResponse, mock_calls: list[RecordedVisionRequest], _: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] status")
            assert_eq(len(mock_calls), 0, f"[{engine}] mock calls")
            assert_json_values_match(expected, resp.json(), f"[{engine}] 10x10 image")

        harness.execute_across_engines(
            "calibrate_small_10x10_200",
            lambda u: http_request(u, "POST", "/api/calibrate_roi.php", headers={"Content-Type": ct}, body=body),
            check,
        )

    # 15. enableAutoCalibration=false gate -> 200
    def test_calibrate_disabled_gate() -> None:
        cfg = harness.baseline_config()
        cfg["senderControl"]["enableAutoCalibration"] = False
        harness.write_config(cfg)
        expected = {
            "success": False,
            "data": None,
            "error": "ADMIN_DISABLED_AUTO_CALIBRATION: 管理员已关闭 AI 自动窗口校准，请改用本地手动框选",
        }
        body, ct = encode_multipart(
            fields={"token": TEST_SENDER_TOKEN},
            files=[("image", "window.png", "image/png", PNG_400X300)],
        )

        def check(engine: str, resp: HttpResponse, mock_calls: list[RecordedVisionRequest], _: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] status")
            assert_eq(len(mock_calls), 0, f"[{engine}] mock calls")
            assert_json_values_match(expected, resp.json(), f"[{engine}] disable calibration gate")

        harness.execute_across_engines(
            "calibrate_disabled_gate",
            lambda u: http_request(u, "POST", "/api/calibrate_roi.php", headers={"Content-Type": ct}, body=body),
            check,
        )

    # 16. Valid 400x300 PNG with <think> + markdown fence + 0..1000 coords
    def test_calibrate_valid_think_and_coords() -> None:
        reset_baseline()
        mock_content = (
            "<think>\nAnalyzing WeCom window layout carefully...\n</think>\n"
            "```json\n"
            '{"success":true,"title_bar":[43,263,97,987],"input_box":[783,261,991,985],'
            '"reason":"检测到与 10001 张三 的私聊窗口"}\n'
            "```"
        )
        harness.mock.state.set_chat_content(mock_content)

        expected = {
            "success": True,
            "data": {
                "title": [0.263, 0.043, 0.724, 0.054],
                "input": [0.261, 0.783, 0.724, 0.208],
                "chat": [0.261, 0.097, 0.726, 0.686],
                "reason": "检测到与 10001 张三 的私聊窗口",
                "duration_ms": 0,
            },
            "error": "ok",
        }
        origin = "https://preview.wxjifang.cn"
        body, ct = encode_multipart(
            fields={},
            files=[("image", "window.png", "image/png", PNG_400X300)],
        )
        expected_b64_url = "data:image/png;base64," + base64.b64encode(PNG_400X300).decode("ascii")
        float_paths = {"$.data.title", "$.data.input", "$.data.chat"}

        def check(engine: str, resp: HttpResponse, mock_calls: list[RecordedVisionRequest], _: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] status")
            assert_cors_headers(engine, origin, resp)
            assert_json_values_match(
                expected,
                resp.json(),
                f"[{engine}] valid calibrate",
                float_array_paths=float_paths,
            )
            assert_eq(len(mock_calls), 1, f"[{engine}] mock call count")
            mc = mock_calls[0]
            assert_eq(mc.path, "/v1/chat/completions", f"[{engine}] mock path")
            assert_eq(mc.authorization, f"Bearer {TEST_VISION_KEY}", f"[{engine}] vision auth")
            assert_eq(mc.body_json["model"], "mock-calibrate-max", f"[{engine}] model")
            assert_eq(float(mc.body_json["temperature"]), 0.0, f"[{engine}] temperature")
            content_parts = mc.body_json["messages"][0]["content"]
            assert_eq(content_parts[1]["image_url"]["url"], expected_b64_url, f"[{engine}] image data url")

        harness.execute_across_engines(
            "calibrate_valid_think_and_coords",
            lambda u: http_request(
                u,
                "POST",
                "/api/calibrate_roi.php",
                headers={
                    "Content-Type": ct,
                    "Authorization": f"Bearer {TEST_SENDER_TOKEN}",
                    "Origin": origin,
                },
                body=body,
            ),
            check,
            origin=origin,
            float_array_paths=float_paths,
        )

    # 17. calibrate_roi upstream error JSON & invalid non-JSON & overlapping boxes
    def test_calibrate_upstream_errors_and_invalid_json() -> None:
        reset_baseline()
        body, ct = encode_multipart(
            fields={"token": TEST_SENDER_TOKEN},
            files=[("image", "window.png", "image/png", PNG_400X300)],
        )

        # Upstream API error JSON
        harness.mock.state.set_json(429, {"error": {"message": "Quota exceeded"}})
        expected_err = {"success": False, "data": None, "error": "视觉模型返回为空：Quota exceeded"}

        def check_err(engine: str, resp: HttpResponse, mock_calls: list[RecordedVisionRequest], _: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] status")
            assert_eq(len(mock_calls), 1, f"[{engine}] mock calls")
            assert_json_values_match(expected_err, resp.json(), f"[{engine}] upstream error")

        harness.execute_across_engines(
            "calibrate_upstream_error_json",
            lambda u: http_request(u, "POST", "/api/calibrate_roi.php", headers={"Content-Type": ct}, body=body),
            check_err,
        )

        # Invalid non-JSON text
        harness.mock.state.set_chat_content("Sorry, I cannot detect the chat window.")
        expected_non_json = {"success": False, "data": None, "error": "视觉模型返回非 JSON"}

        def check_non_json(engine: str, resp: HttpResponse, mock_calls: list[RecordedVisionRequest], _: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] status")
            assert_eq(len(mock_calls), 1, f"[{engine}] mock calls")
            assert_json_values_match(expected_non_json, resp.json(), f"[{engine}] non-JSON")

        harness.execute_across_engines(
            "calibrate_invalid_non_json",
            lambda u: http_request(u, "POST", "/api/calibrate_roi.php", headers={"Content-Type": ct}, body=body),
            check_non_json,
        )

        # Overlapping input_box over title_bar
        harness.mock.state.set_chat_content(
            '{"success":true,"title_bar":[40,260,120,980],"input_box":[100,260,300,980],"reason":"bad"}'
        )
        expected_overlap = {"success": False, "data": None, "error": "检测到输入框位置异常（压住标题栏）"}

        def check_overlap(engine: str, resp: HttpResponse, _: list[RecordedVisionRequest], __: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] status")
            assert_json_values_match(expected_overlap, resp.json(), f"[{engine}] overlap box")

        harness.execute_across_engines(
            "calibrate_overlapping_boxes",
            lambda u: http_request(u, "POST", "/api/calibrate_roi.php", headers={"Content-Type": ct}, body=body),
            check_overlap,
        )

    # 18. GET /api/identify.php -> 405
    def test_identify_get_405() -> None:
        expected = {"success": False, "data": None, "error": "仅支持 POST"}

        def check(engine: str, resp: HttpResponse, _: list[RecordedVisionRequest], __: set[str]) -> None:
            assert_eq(resp.status, 405, f"[{engine}] status")
            assert_json_values_match(expected, resp.json(), f"[{engine}] identify GET 405")

        harness.execute_across_engines(
            "identify_get_405",
            lambda u: http_request(u, "GET", "/api/identify.php"),
            check,
        )

    # 19. POST /api/identify.php CSRF + bad token + empty target + missing/non-image
    def test_identify_validation_and_auth() -> None:
        reset_baseline()

        # CSRF
        origin = "https://evil.example"
        harness.execute_across_engines(
            "identify_csrf_403",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Origin": origin}),
            lambda e, r, m, _: (
                assert_eq(r.status, 403, f"[{e}] status"),
                assert_cors_headers(e, origin, r),
                assert_json_values_match(
                    {"success": False, "data": None, "error": "非法跨站请求 (CSRF Origin Mismatch)"},
                    r.json(),
                    f"[{e}] identify CSRF",
                ),
            ),
            origin=origin,
        )

        # Bad token -> 200 鉴权失败
        bad_body, bad_ct = encode_multipart(fields={"token": "invalid-token", "target_id": "10001"})
        harness.execute_across_engines(
            "identify_bad_token",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": bad_ct}, body=bad_body),
            lambda e, r, m, _: (
                assert_eq(r.status, 200, f"[{e}] status"),
                assert_eq(len(m), 0, f"[{e}] mock calls"),
                assert_json_values_match({"success": False, "data": None, "error": "鉴权失败"}, r.json(), f"[{e}] bad token"),
            ),
        )

        # Empty target_id & target_name on mode=full -> 400
        empty_body, empty_ct = encode_multipart(fields={"token": TEST_SENDER_TOKEN, "mode": "full"})
        harness.execute_across_engines(
            "identify_empty_target_400",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": empty_ct}, body=empty_body),
            lambda e, r, m, _: (
                assert_eq(r.status, 400, f"[{e}] status"),
                assert_json_values_match(
                    {"success": False, "data": None, "error": "target_id 与 target_name 不能同时为空"},
                    r.json(),
                    f"[{e}] empty target",
                ),
            ),
        )

        # Missing image_chat on mode=full -> 400
        miss_body, miss_ct = encode_multipart(
            fields={"token": TEST_SENDER_TOKEN, "mode": "full", "target_id": "10001"},
            files=[("image_title", "title.png", "image/png", PNG_400X300)],
        )
        harness.execute_across_engines(
            "identify_missing_image_chat_400",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": miss_ct}, body=miss_body),
            lambda e, r, m, _: (
                assert_eq(r.status, 400, f"[{e}] status"),
                assert_json_values_match(
                    {"success": False, "data": None, "error": "缺少上传图：image_chat"},
                    r.json(),
                    f"[{e}] missing image_chat",
                ),
            ),
        )

        # Non-image uploaded as image_title -> 400
        badimg_body, badimg_ct = encode_multipart(
            fields={"token": TEST_SENDER_TOKEN, "mode": "full", "target_id": "10001"},
            files=[
                ("image_title", "not-an-image.txt", "text/plain", INVALID_TEXT_BYTES),
                ("image_chat", "chat.png", "image/png", PNG_400X300),
            ],
        )
        harness.execute_across_engines(
            "identify_non_image_400",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": badimg_ct}, body=badimg_body),
            lambda e, r, m, _: (
                assert_eq(r.status, 400, f"[{e}] status"),
                assert_json_values_match(
                    {"success": False, "data": None, "error": "只收 PNG/JPEG：image_title"},
                    r.json(),
                    f"[{e}] non-image",
                ),
            ),
        )

    # 20. Admin gates: disableQwenFlashTitle=true, verifyMode=local, enableBenchmarkModel=false, enableReplyAnalysis=false
    def test_identify_admin_gates() -> None:
        # Gate via disableQwenFlashTitle=true (without senderControl.verifyMode)
        cfg1 = harness.baseline_config(disableQwenFlashTitle=True, senderControl={})
        harness.write_config(cfg1)

        title_body, title_ct = encode_multipart(
            fields={"token": TEST_SENDER_TOKEN, "mode": "title", "target_id": "10001"},
            files=[("image_title", "title.png", "image/png", PNG_400X300)],
        )
        harness.execute_across_engines(
            "identify_gate_disableQwenFlashTitle_title",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": title_ct}, body=title_body),
            lambda e, r, m, _: (
                assert_eq(r.status, 200, f"[{e}] status"),
                assert_eq(len(m), 0, f"[{e}] mock calls"),
                assert_json_values_match(
                    {
                        "success": False,
                        "data": None,
                        "error": "ADMIN_FORCED_LOCAL_OCR: 管理员已开启强制本地OCR核验，云端标题核验模型已停用",
                    },
                    r.json(),
                    f"[{e}] disableQwenFlashTitle title",
                ),
            ),
        )

        full_body, full_ct = encode_multipart(
            fields={"token": TEST_SENDER_TOKEN, "mode": "full", "target_id": "10001"},
            files=[
                ("image_title", "title.png", "image/png", PNG_400X300),
                ("image_chat", "chat.png", "image/png", PNG_400X300),
            ],
        )
        harness.execute_across_engines(
            "identify_gate_disableQwenFlashTitle_full",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": full_ct}, body=full_body),
            lambda e, r, m, _: (
                assert_eq(r.status, 200, f"[{e}] status"),
                assert_eq(len(m), 0, f"[{e}] mock calls"),
                assert_json_values_match(
                    {
                        "success": False,
                        "data": None,
                        "error": "ADMIN_FORCED_LOCAL_OCR: 管理员已开启强制本地OCR核验，云端全图核验已停用",
                    },
                    r.json(),
                    f"[{e}] disableQwenFlashTitle full",
                ),
            ),
        )

        # Gate via senderControl.verifyMode=local, enableBenchmarkModel=false, enableReplyAnalysis=false
        cfg2 = harness.baseline_config(disableQwenFlashTitle=False)
        cfg2["senderControl"]["verifyMode"] = "local"
        cfg2["senderControl"]["enableBenchmarkModel"] = False
        cfg2["senderControl"]["enableReplyAnalysis"] = False
        harness.write_config(cfg2)

        harness.execute_across_engines(
            "identify_gate_verifyMode_local_title",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": title_ct}, body=title_body),
            lambda e, r, m, _: (
                assert_eq(r.status, 200, f"[{e}] status"),
                assert_eq(len(m), 0, f"[{e}] mock calls"),
                assert_json_values_match(
                    {
                        "success": False,
                        "data": None,
                        "error": "ADMIN_FORCED_LOCAL_OCR: 管理员已开启强制本地OCR核验，云端标题核验模型已停用",
                    },
                    r.json(),
                    f"[{e}] verifyMode=local title",
                ),
            ),
        )

        harness.execute_across_engines(
            "identify_gate_verifyMode_local_full",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": full_ct}, body=full_body),
            lambda e, r, m, _: (
                assert_eq(r.status, 200, f"[{e}] status"),
                assert_eq(len(m), 0, f"[{e}] mock calls"),
                assert_json_values_match(
                    {
                        "success": False,
                        "data": None,
                        "error": "ADMIN_FORCED_LOCAL_OCR: 管理员已开启强制本地OCR核验，云端全图核验已停用",
                    },
                    r.json(),
                    f"[{e}] verifyMode=local full",
                ),
            ),
        )

        bench_body, bench_ct = encode_multipart(
            fields={"token": TEST_SENDER_TOKEN, "mode": "title", "purpose": "benchmark", "target_id": "10001"},
            files=[("image_title", "title.png", "image/png", PNG_400X300)],
        )
        harness.execute_across_engines(
            "identify_gate_benchmark_disabled",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": bench_ct}, body=bench_body),
            lambda e, r, m, _: (
                assert_eq(r.status, 200, f"[{e}] status"),
                assert_eq(len(m), 0, f"[{e}] mock calls"),
                assert_json_values_match(
                    {
                        "success": False,
                        "data": None,
                        "error": "ADMIN_DISABLED_BENCHMARK_MODEL: 管理员已停用基准评测云端大模型",
                    },
                    r.json(),
                    f"[{e}] benchmark disabled",
                ),
            ),
        )

        reply_body, reply_ct = encode_multipart(
            fields={"token": TEST_SENDER_TOKEN, "mode": "reply", "target_id": "10001"},
            files=[("image_chat", "chat.png", "image/png", PNG_400X300)],
        )
        harness.execute_across_engines(
            "identify_gate_reply_disabled",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": reply_ct}, body=reply_body),
            lambda e, r, m, _: (
                assert_eq(r.status, 200, f"[{e}] status"),
                assert_eq(len(m), 0, f"[{e}] mock calls"),
                assert_json_values_match(
                    {
                        "success": False,
                        "data": None,
                        "error": "ADMIN_DISABLED_REPLY_ANALYSIS: 管理员已关闭后台家长留言分析大模型",
                    },
                    r.json(),
                    f"[{e}] reply disabled",
                ),
            ),
        )

    # 21. Valid full mode + strict-bool edge cases + config overrides + archive check
    def test_identify_full_strict_bool_and_archive() -> None:
        cfg = harness.baseline_config(
            dashscopeApiKey="sk-config-override-key",
            identifyApiBase=f"http://127.0.0.1:{mock_port}/custom/chat/completions",
            identifyModel="mock-id-max",
            identifyFastModel="mock-id-flash",
            benchmarkModel="mock-bench-model",
            calibrateModel="mock-cal-max",
        )
        harness.write_config(cfg)

        raw_content = (
            "<think>verifying target student...</think>\n"
            "```json\n"
            '{"matched":1,"is_group":"true","title_in_header":true,'
            '"detected_title":"10001_张三","last_sender":"hacker",'
            '"last_message_text":"收到，谢谢老师！","needs_reply":null,'
            '"reason":"strict bool edge case"}\n'
            "```"
        )
        harness.mock.state.set_chat_content(raw_content)

        expected_mapped = {
            "matched": False,
            "is_group": False,
            "title_in_header": True,
            "detected_title": "10001_张三",
            "last_sender": "unknown",
            "last_message_text": "收到，谢谢老师！",
            "needs_reply": None,
            "reason": "strict bool edge case",
            "duration_ms": 0,
        }
        expected_resp = {"success": True, "data": expected_mapped, "error": None}
        body, ct = encode_multipart(
            fields={"mode": "full", "target_id": "10001", "target_name": "张三"},
            files=[
                ("image_title", "title.png", "image/png", PNG_400X300),
                ("image_chat", "chat.png", "image/png", PNG_400X300),
            ],
        )

        def check(engine: str, resp: HttpResponse, mock_calls: list[RecordedVisionRequest], new_archives: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] status")
            assert_json_values_match(expected_resp, resp.json(), f"[{engine}] full strict bool")
            assert_eq(len(mock_calls), 1, f"[{engine}] mock calls")
            mc = mock_calls[0]
            assert_eq(mc.path, "/custom/chat/completions", f"[{engine}] no duplicate /chat/completions")
            assert_eq(mc.authorization, "Bearer sk-config-override-key", f"[{engine}] config dashscopeApiKey")
            assert_eq(mc.body_json["model"], "mock-id-max", f"[{engine}] identifyModel")
            verify_archive_entry(
                harness,
                engine,
                new_archives,
                expected_mode="full",
                expected_target_id="10001",
                expected_target_name="张三",
                expected_detected_title="",
                expected_model="mock-id-max",
                expected_pngs=["title.png", "chat.png"],
                forbidden_pngs=["window.png"],
                expected_raw_content=raw_content,
                expected_mapped=expected_mapped,
            )

        harness.execute_across_engines(
            "identify_full_strict_bool_and_archive",
            lambda u: http_request(
                u,
                "POST",
                "/api/identify.php",
                headers={"Content-Type": ct, "Authorization": f"Bearer {TEST_SENDER_TOKEN}"},
                body=body,
            ),
            check,
        )

    # 22. Valid title & title+benchmark modes + archive check
    def test_identify_title_and_benchmark_and_archive() -> None:
        reset_baseline()

        # title mode -> identifyFastModel
        raw_content = '{"matched":true,"is_group":false,"title_in_header":true,"detected_title":"10002_李四","reason":"学号姓名一致"}'
        harness.mock.state.set_chat_content(raw_content)
        expected_mapped = {
            "matched": True,
            "is_group": False,
            "title_in_header": True,
            "detected_title": "10002_李四",
            "last_sender": None,
            "last_message_text": "",
            "needs_reply": None,
            "reason": "学号姓名一致",
            "duration_ms": 0,
        }
        expected_resp = {"success": True, "data": expected_mapped, "error": None}
        body, ct = encode_multipart(
            fields={"token": TEST_SENDER_TOKEN, "mode": "title", "target_id": "10002", "target_name": "李四"},
            files=[("image_title", "title.png", "image/png", PNG_400X300)],
        )

        def check_title(engine: str, resp: HttpResponse, mock_calls: list[RecordedVisionRequest], new_archives: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] status")
            assert_json_values_match(expected_resp, resp.json(), f"[{engine}] title mode")
            assert_eq(len(mock_calls), 1, f"[{engine}] mock calls")
            assert_eq(mock_calls[0].body_json["model"], "mock-vision-flash", f"[{engine}] fast model")
            verify_archive_entry(
                harness,
                engine,
                new_archives,
                expected_mode="title",
                expected_target_id="10002",
                expected_target_name="李四",
                expected_detected_title="",
                expected_model="mock-vision-flash",
                expected_pngs=["title.png"],
                forbidden_pngs=["chat.png", "window.png"],
                expected_raw_content=raw_content,
                expected_mapped=expected_mapped,
            )

        harness.execute_across_engines(
            "identify_title_mode_and_archive",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": ct}, body=body),
            check_title,
        )

        # title + purpose=benchmark -> benchmarkModel
        bench_body, bench_ct = encode_multipart(
            fields={
                "token": TEST_SENDER_TOKEN,
                "mode": "title",
                "purpose": "benchmark",
                "target_id": "10002",
                "target_name": "李四",
            },
            files=[("image_title", "title.png", "image/png", PNG_400X300)],
        )

        def check_bench(engine: str, resp: HttpResponse, mock_calls: list[RecordedVisionRequest], new_archives: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] status")
            assert_json_values_match(expected_resp, resp.json(), f"[{engine}] benchmark mode")
            assert_eq(len(mock_calls), 1, f"[{engine}] mock calls")
            assert_eq(mock_calls[0].body_json["model"], "mock-benchmark-model", f"[{engine}] benchmarkModel")
            verify_archive_entry(
                harness,
                engine,
                new_archives,
                expected_mode="title",
                expected_target_id="10002",
                expected_target_name="李四",
                expected_detected_title="",
                expected_model="mock-benchmark-model",
                expected_pngs=["title.png"],
                forbidden_pngs=["chat.png", "window.png"],
                expected_raw_content=raw_content,
                expected_mapped=expected_mapped,
            )

        harness.execute_across_engines(
            "identify_benchmark_mode_and_archive",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": bench_ct}, body=bench_body),
            check_bench,
        )

    # 23. Valid reply mode + archive check
    def test_identify_reply_mode_and_archive() -> None:
        reset_baseline()
        raw_content = '{"last_sender":"parent","last_message_text":"请问明天带什么资料？","needs_reply":"true","reason":"家长提问待回复"}'
        harness.mock.state.set_chat_content(raw_content)

        expected_mapped = {
            "matched": False,
            "is_group": False,
            "title_in_header": False,
            "detected_title": "",
            "last_sender": "parent",
            "last_message_text": "请问明天带什么资料？",
            "needs_reply": True,
            "reason": "家长提问待回复",
            "duration_ms": 0,
        }
        expected_resp = {"success": True, "data": expected_mapped, "error": None}
        body, ct = encode_multipart(
            fields={
                "token": TEST_SENDER_TOKEN,
                "mode": "reply",
                "target_id": "10003",
                "target_name": "王五",
                "detected_title": "10003_王五",
            },
            files=[("image_chat", "chat.png", "image/png", PNG_400X300)],
        )

        def check(engine: str, resp: HttpResponse, mock_calls: list[RecordedVisionRequest], new_archives: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] status")
            assert_json_values_match(expected_resp, resp.json(), f"[{engine}] reply mode")
            assert_eq(len(mock_calls), 1, f"[{engine}] mock calls")
            assert_eq(mock_calls[0].body_json["model"], "mock-vision-max", f"[{engine}] identifyModel")
            verify_archive_entry(
                harness,
                engine,
                new_archives,
                expected_mode="reply",
                expected_target_id="10003",
                expected_target_name="王五",
                expected_detected_title="10003_王五",
                expected_model="mock-vision-max",
                expected_pngs=["chat.png"],
                forbidden_pngs=["title.png", "window.png"],
                expected_raw_content=raw_content,
                expected_mapped=expected_mapped,
            )

        harness.execute_across_engines(
            "identify_reply_mode_and_archive",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": ct}, body=body),
            check,
        )

    # 24. Valid sidebar mode (allows empty target_id & target_name, ignores local OCR gate) + archive check
    def test_identify_sidebar_mode_and_archive() -> None:
        cfg = harness.baseline_config(disableQwenFlashTitle=True)
        cfg["senderControl"]["verifyMode"] = "local"
        cfg["senderControl"]["enableReplyAnalysis"] = False
        harness.write_config(cfg)

        raw_content = '{"has_sidebar":1,"sidebar_title":"学员详情","reason":"主聊天区右侧展开了独立侧边栏"}'
        harness.mock.state.set_chat_content(raw_content)

        expected_mapped = {
            "has_sidebar": True,
            "sidebar_title": "学员详情",
            "reason": "主聊天区右侧展开了独立侧边栏",
            "duration_ms": 0,
        }
        expected_resp = {"success": True, "data": expected_mapped, "error": None}
        body, ct = encode_multipart(
            fields={"token": TEST_SENDER_TOKEN, "mode": "sidebar"},
            files=[("image_window", "window.png", "image/png", PNG_400X300)],
        )

        def check(engine: str, resp: HttpResponse, mock_calls: list[RecordedVisionRequest], new_archives: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] status")
            assert_json_values_match(expected_resp, resp.json(), f"[{engine}] sidebar mode")
            assert_eq(len(mock_calls), 1, f"[{engine}] mock calls")
            assert_eq(mock_calls[0].body_json["model"], "mock-calibrate-max", f"[{engine}] sidebar uses calibrateModel")
            verify_archive_entry(
                harness,
                engine,
                new_archives,
                expected_mode="sidebar",
                expected_target_id="",
                expected_target_name="",
                expected_detected_title="",
                expected_model="mock-calibrate-max",
                expected_pngs=["window.png"],
                forbidden_pngs=["title.png", "chat.png"],
                expected_raw_content=raw_content,
                expected_mapped=expected_mapped,
            )

        harness.execute_across_engines(
            "identify_sidebar_mode_and_archive",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": ct}, body=body),
            check,
        )

    # 25. identify upstream error JSON & invalid non-JSON text
    def test_identify_upstream_errors_and_non_json() -> None:
        reset_baseline()
        body, ct = encode_multipart(
            fields={"token": TEST_SENDER_TOKEN, "mode": "reply", "target_id": "10004"},
            files=[("image_chat", "chat.png", "image/png", PNG_400X300)],
        )

        harness.mock.state.set_json(500, {"error": {"message": "Upstream model overloaded"}})
        expected_err = {"success": False, "data": None, "error": "视觉模型返回为空：Upstream model overloaded"}
        harness.execute_across_engines(
            "identify_upstream_error_json",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": ct}, body=body),
            lambda e, r, m, a: (
                assert_eq(r.status, 200, f"[{e}] status"),
                assert_eq(len(m), 1, f"[{e}] mock calls"),
                assert_eq(len(a), 0, f"[{e}] no archive on error"),
                assert_json_values_match(expected_err, r.json(), f"[{e}] identify upstream error"),
            ),
        )

        harness.mock.state.set_chat_content("not valid json response")
        expected_non_json = {"success": False, "data": None, "error": "视觉模型返回非 JSON"}
        harness.execute_across_engines(
            "identify_invalid_non_json",
            lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": ct}, body=body),
            lambda e, r, m, a: (
                assert_eq(r.status, 200, f"[{e}] status"),
                assert_eq(len(m), 1, f"[{e}] mock calls"),
                assert_eq(len(a), 0, f"[{e}] no archive on non-json"),
                assert_json_values_match(expected_non_json, r.json(), f"[{e}] identify non-JSON"),
            ),
        )

    # 26. changelog.php public actions & unknown action (400) & unauth write actions (401)
    def test_changelog_public_and_unauth() -> None:
        ch_file = harness.feedback_root / "data" / "changelog.json"
        if ch_file.exists():
            ch_file.unlink()

        def check_active(engine: str, resp: HttpResponse, _: list[RecordedVisionRequest], __: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] getActive status")
            j = resp.json()
            assert_eq(j.get("success"), True, f"[{engine}] getActive success")
            assert_true(isinstance(j.get("data"), dict) and j["data"].get("id") == "update_2026_11_12", f"[{engine}] getActive data={j!r}")

        harness.execute_across_engines(
            "changelog_getActive",
            lambda u: http_request(u, "GET", "/api/changelog.php?action=getActive"),
            check_active,
        )

        def check_all(engine: str, resp: HttpResponse, _: list[RecordedVisionRequest], __: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] getAll status")
            j = resp.json()
            assert_eq(j.get("success"), True, f"[{engine}] getAll success")
            assert_true(isinstance(j.get("data"), list) and len(j["data"]) >= 1, f"[{engine}] getAll data={j!r}")

        harness.execute_across_engines(
            "changelog_getAll",
            lambda u: http_request(u, "GET", "/api/changelog.php?action=getAll"),
            check_all,
        )

        harness.execute_across_engines(
            "changelog_unknown_action_400",
            lambda u: http_request(u, "GET", "/api/changelog.php?action=unknown_op"),
            lambda e, r, _, __: (
                assert_eq(r.status, 400, f"[{e}] unknown action status"),
                assert_json_values_match({"success": False, "error": "未知的操作"}, r.json(), f"[{e}] unknown action"),
            ),
        )

        for act in ("save", "delete", "setActive"):
            harness.execute_across_engines(
                f"changelog_unauth_{act}_401",
                lambda u, a=act: http_request(
                    u,
                    "POST",
                    f"/api/changelog.php?action={a}",
                    headers={"Content-Type": "application/json"},
                    body=b"{}",
                ),
                lambda e, r, _, __, a=act: (
                    assert_eq(r.status, 401, f"[{e}] changelog {a} unauth status"),
                    assert_json_values_match(
                        {"success": False, "data": None, "error": "未登录或会话已过期，需管理员权限"},
                        r.json(),
                        f"[{e}] changelog {a} unauth",
                    ),
                ),
            )

    # 27. upload_pdf.php unauthenticated GET/POST -> 401
    def test_upload_pdf_unauth_401() -> None:
        expected = {"success": False, "data": None, "error": "未登录或登录会话已过期，请重新登录"}
        for method in ("GET", "POST"):
            harness.execute_across_engines(
                f"upload_pdf_unauth_{method}_401",
                lambda u, m=method: http_request(u, m, "/api/upload_pdf.php"),
                lambda e, r, _, __, m=method: (
                    assert_eq(r.status, 401, f"[{e}] upload_pdf {m} unauth status"),
                    assert_json_values_match(expected, r.json(), f"[{e}] upload_pdf {m} unauth"),
                ),
            )

    # 28. upload_capture.php unauthenticated POST -> 401
    def test_upload_capture_unauth_401() -> None:
        expected = {"success": False, "data": None, "error": "未登录或登录会话已过期，请重新登录"}
        harness.execute_across_engines(
            "upload_capture_unauth_POST_401",
            lambda u: http_request(u, "POST", "/api/upload_capture.php"),
            lambda e, r, _, __: (
                assert_eq(r.status, 401, f"[{e}] upload_capture unauth status"),
                assert_json_values_match(expected, r.json(), f"[{e}] upload_capture unauth"),
            ),
        )

    # 29. data/.ai_secrets.json key isolation (no leak in public_config; used by calibrate_roi & identify)
    def test_ai_secrets_json_isolation() -> None:
        ai_secrets_path = harness.feedback_root / "data" / ".ai_secrets.json"
        isolated_key = "sk-isolated-ai-secrets-json-key-2026"
        try:
            ai_secrets_path.write_text(
                json.dumps({"dashscopeApiKey": isolated_key, "updatedAt": "2026-11-21 20:00:00"}),
                encoding="utf-8",
            )
            harness.write_config(harness.baseline_config(dashscopeApiKey=""))

            # public_config.php must never leak isolated key
            harness.execute_across_engines(
                "ai_secrets_not_leaked_in_public_config",
                lambda u: http_request(u, "GET", "/api/public_config.php"),
                lambda e, r, _, __: (
                    assert_eq(r.status, 200, f"[{e}] status"),
                    assert_true(isolated_key not in r.text, f"[{e}] leaked isolated key in public_config"),
                    assert_true("dashscopeApiKey" not in r.text, f"[{e}] leaked dashscopeApiKey field"),
                ),
                check_cache_control=True,
            )

            # identify.php reads dashscopeApiKey from data/.ai_secrets.json (overrides secret_key.local.php)
            raw_content = '{"matched":true,"is_group":false,"title_in_header":true,"detected_title":"10099_赵六","reason":"ok"}'
            harness.mock.state.set_chat_content(raw_content)
            body, ct = encode_multipart(
                fields={"token": TEST_SENDER_TOKEN, "mode": "title", "target_id": "10099", "target_name": "赵六"},
                files=[("image_title", "title.png", "image/png", PNG_400X300)],
            )
            harness.execute_across_engines(
                "ai_secrets_used_by_identify",
                lambda u: http_request(u, "POST", "/api/identify.php", headers={"Content-Type": ct}, body=body),
                lambda e, r, m, _: (
                    assert_eq(r.status, 200, f"[{e}] status"),
                    assert_eq(len(m), 1, f"[{e}] mock calls"),
                    assert_eq(m[0].authorization, f"Bearer {isolated_key}", f"[{e}] isolated key auth header"),
                ),
            )
        finally:
            if ai_secrets_path.exists():
                ai_secrets_path.unlink()

    # 30. Array-typed senderApiTokens in api/secret_key.local.php with ALLOW_DEFAULT_SENDER_TOKEN=false
    def test_multi_sender_tokens_and_strict_no_default() -> None:
        reset_baseline()
        secret_local = harness.feedback_root / "api" / "secret_key.local.php"
        orig_secret_text = secret_local.read_text(encoding="utf-8")
        try:
            secret_local.write_text(
                "<?php\n"
                "return [\n"
                f"    'retestSecret' => '{TEST_RETEST_SECRET}',\n"
                "    'senderApiTokens' => ['tok_rot_1', 'tok_rot_2'],\n"
                f"    'dashscopeApiKey' => '{TEST_VISION_KEY}',\n"
                f"    'identifyApiBase' => 'http://127.0.0.1:{mock_port}/v1',\n"
                "];\n",
                encoding="utf-8",
            )

            # Both rotated tokens must be accepted (passes auth -> 400 missing image)
            for rot_tok in ("tok_rot_1", "tok_rot_2"):
                b_ok, ct_ok = encode_multipart(fields={"token": rot_tok})
                harness.execute_across_engines(
                    f"multi_token_accepted_{rot_tok}",
                    lambda u, b=b_ok, c=ct_ok: http_request(
                        u, "POST", "/api/calibrate_roi.php", headers={"Content-Type": c}, body=b
                    ),
                    lambda e, r, _, __, t=rot_tok: (
                        assert_eq(r.status, 400, f"[{e}:{t}] expected 400 past auth"),
                        assert_json_values_match(
                            {"success": False, "data": None, "error": "缺少上传整窗截图：image"},
                            r.json(),
                            f"[{e}:{t}] accepted rotated token",
                        ),
                    ),
                )

            # Default token and invalid token must be rejected (200 鉴权失败)
            for bad_label, bad_tok in (("default_tok", DEFAULT_SENDER_TOKEN), ("invalid_tok", "not_in_rotation")):
                b_bad, ct_bad = encode_multipart(fields={"token": bad_tok})
                harness.execute_across_engines(
                    f"multi_token_rejected_{bad_label}",
                    lambda u, b=b_bad, c=ct_bad: http_request(
                        u, "POST", "/api/calibrate_roi.php", headers={"Content-Type": c}, body=b
                    ),
                    lambda e, r, _, __, lbl=bad_label: (
                        assert_eq(r.status, 200, f"[{e}:{lbl}] status"),
                        assert_json_values_match(
                            {"success": False, "data": None, "error": "鉴权失败"},
                            r.json(),
                            f"[{e}:{lbl}] rejected token",
                        ),
                    ),
                )

            # When no custom token is configured and ALLOW_DEFAULT_SENDER_TOKEN=false, default token is rejected
            secret_local.write_text(
                "<?php\n"
                "return [\n"
                f"    'retestSecret' => '{TEST_RETEST_SECRET}',\n"
                f"    'dashscopeApiKey' => '{TEST_VISION_KEY}',\n"
                "];\n",
                encoding="utf-8",
            )
            b_def, ct_def = encode_multipart(fields={"token": DEFAULT_SENDER_TOKEN})
            harness.execute_across_engines(
                "strict_no_default_token_when_unconfigured",
                lambda u: http_request(
                    u, "POST", "/api/calibrate_roi.php", headers={"Content-Type": ct_def}, body=b_def
                ),
                lambda e, r, _, __: (
                    assert_eq(r.status, 200, f"[{e}] status"),
                    assert_json_values_match(
                        {"success": False, "data": None, "error": "鉴权失败"},
                        r.json(),
                        f"[{e}] strict default token disabled",
                    ),
                ),
            )
        finally:
            secret_local.write_text(orig_secret_text, encoding="utf-8")

    # 31. JPEG upload in calibrate_roi.php & identify.php + X-Forwarded-For / X-Real-IP extraction
    def test_jpeg_upload_and_forwarded_ip_headers() -> None:
        reset_baseline()
        expected_jpeg_url = "data:image/jpeg;base64," + base64.b64encode(JPEG_400X300).decode("ascii")

        # calibrate_roi.php with JPEG
        cal_content = '{"success":true,"title_bar":[40,260,90,980],"input_box":[780,260,990,980],"reason":"jpeg window"}'
        harness.mock.state.set_chat_content(cal_content)
        cal_body, cal_ct = encode_multipart(
            fields={"token": TEST_SENDER_TOKEN},
            files=[("image", "window.jpg", "image/jpeg", JPEG_400X300)],
        )
        float_paths = {"$.data.title", "$.data.input", "$.data.chat"}
        harness.execute_across_engines(
            "calibrate_jpeg_upload",
            lambda u: http_request(
                u, "POST", "/api/calibrate_roi.php", headers={"Content-Type": cal_ct}, body=cal_body
            ),
            lambda e, r, m, _: (
                assert_eq(r.status, 200, f"[{e}] status"),
                assert_eq(len(m), 1, f"[{e}] mock calls"),
                assert_eq(
                    m[0].body_json["messages"][0]["content"][1]["image_url"]["url"],
                    expected_jpeg_url,
                    f"[{e}] JPEG data URL",
                ),
            ),
            float_array_paths=float_paths,
        )

        # identify.php with JPEG + X-Forwarded-For (rightmost public IP selected) & X-Real-IP
        id_content = '{"matched":true,"is_group":false,"title_in_header":true,"detected_title":"10088_孙七","reason":"jpeg ok"}'
        harness.mock.state.set_chat_content(id_content)
        id_body, id_ct = encode_multipart(
            fields={"token": TEST_SENDER_TOKEN, "mode": "title", "target_id": "10088", "target_name": "孙七"},
            files=[("image_title", "title.jpg", "image/jpeg", JPEG_400X300)],
        )
        for hdr_label, ip_hdrs, expected_ip in [
            ("xff_public", {"X-Forwarded-For": "10.0.0.1, 8.8.8.8, 192.168.1.5"}, "8.8.8.8"),
            ("x_real_ip", {"X-Real-IP": "1.1.1.1", "X-Forwarded-For": "8.8.8.8"}, "1.1.1.1"),
        ]:
            def check_id_jpeg(
                engine: str,
                resp: HttpResponse,
                mock_calls: list[RecordedVisionRequest],
                new_archives: set[str],
                exp_ip: str = expected_ip,
            ) -> None:
                assert_eq(resp.status, 200, f"[{engine}] status")
                assert_eq(len(mock_calls), 1, f"[{engine}] mock calls")
                assert_eq(
                    mock_calls[0].body_json["messages"][0]["content"][1]["image_url"]["url"],
                    expected_jpeg_url,
                    f"[{engine}] identify JPEG data URL",
                )
                assert_eq(len(new_archives), 1, f"[{engine}] archive count")
                dirname = next(iter(new_archives))
                req_doc = json.loads((harness.archive_day_dir() / dirname / "request.json").read_text(encoding="utf-8"))
                assert_eq(req_doc["ip"], exp_ip, f"[{engine}] archived client IP")

            harness.execute_across_engines(
                f"identify_jpeg_and_{hdr_label}",
                lambda u, h=ip_hdrs: http_request(
                    u, "POST", "/api/identify.php", headers={"Content-Type": id_ct, **h}, body=id_body
                ),
                check_id_jpeg,
            )

    # 32. auth.php check, captcha PNG, logout, and unauthenticated assistant_list/create (401)
    def test_auth_endpoints_parity() -> None:
        # GET ?action=check
        harness.execute_across_engines(
            "auth_check_logged_out",
            lambda u: http_request(u, "GET", "/api/auth.php?action=check"),
            lambda e, r, _, __: (
                assert_eq(r.status, 200, f"[{e}] auth check status"),
                assert_json_values_match(
                    {"success": True, "data": {"loggedIn": False, "require_captcha": False}, "error": None},
                    r.json(),
                    f"[{e}] auth check JSON",
                ),
            ),
        )

        # GET ?action=captcha -> 200 image/png with 130x42 dimensions
        def check_auth_captcha(engine: str, resp: HttpResponse, _: list[RecordedVisionRequest], __: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] auth captcha status")
            assert_true("image/png" in resp.headers.get("content-type", "").lower(), f"[{engine}] Content-Type")
            assert_true(resp.body.startswith(PNG_MAGIC), f"[{engine}] PNG magic bytes")
            w, h = struct.unpack(">II", resp.body[16:24])
            assert_eq((w, h), (130, 42), f"[{engine}] captcha PNG dimensions")

        harness.execute_across_engines(
            "auth_captcha_png",
            lambda u: http_request(u, "GET", "/api/auth.php?action=captcha"),
            check_auth_captcha,
            expect_json=False,
            check_cache_control=True,
        )

        # POST ?action=logout
        harness.execute_across_engines(
            "auth_logout_200",
            lambda u: http_request(u, "POST", "/api/auth.php?action=logout"),
            lambda e, r, _, __: (
                assert_eq(r.status, 200, f"[{e}] auth logout status"),
                assert_json_values_match(
                    {"success": True, "data": {"message": "已成功退出登录"}, "error": None},
                    r.json(),
                    f"[{e}] auth logout JSON",
                ),
            ),
        )

        # Unauthenticated assistant_list & assistant_create -> 401
        harness.execute_across_engines(
            "auth_unauth_assistant_list_401",
            lambda u: http_request(u, "GET", "/api/auth.php?action=assistant_list"),
            lambda e, r, _, __: (
                assert_eq(r.status, 401, f"[{e}] assistant_list unauth status"),
                assert_json_values_match(
                    {"success": False, "data": None, "error": "需要教师或管理员登录后才可管理助教账号"},
                    r.json(),
                    f"[{e}] assistant_list unauth",
                ),
            ),
        )
        harness.execute_across_engines(
            "auth_unauth_assistant_create_401",
            lambda u: http_request(
                u,
                "POST",
                "/api/auth.php?action=assistant_create",
                headers={"Content-Type": "application/json"},
                body=b"{}",
            ),
            lambda e, r, _, __: (
                assert_eq(r.status, 401, f"[{e}] assistant_create unauth status"),
                assert_json_values_match(
                    {"success": False, "data": None, "error": "需要教师或管理员登录后才可创建助教账号"},
                    r.json(),
                    f"[{e}] assistant_create unauth",
                ),
            ),
        )

    # 33. qbank.php unauthenticated GET ?action=list, POST, DELETE -> 401
    def test_qbank_unauth_401() -> None:
        expected = {"success": False, "data": None, "error": "未登录或登录会话已过期，请重新登录"}
        for method, path, body in [
            ("GET", "/api/qbank.php?action=list", None),
            ("POST", "/api/qbank.php", b"{}"),
            ("DELETE", "/api/qbank.php?subject=%E6%95%B0%E5%AD%A6&grade=%E4%B8%83%E5%B9%B4%E7%BA%A7&tier=U&week=1", None),
        ]:
            harness.execute_across_engines(
                f"qbank_unauth_{method}_401",
                lambda u, m=method, p=path, b=body: http_request(u, m, p, body=b),
                lambda e, r, _, __, m=method: (
                    assert_eq(r.status, 401, f"[{e}] qbank {m} unauth status"),
                    assert_json_values_match(expected, r.json(), f"[{e}] qbank {m} unauth"),
                ),
            )

    # 34. logs.php sender_control_pull (GET/POST with clients/<slug>.json api/always), sender_sync, unauth 401
    def test_logs_sender_control_sync_and_unauth() -> None:
        reset_baseline()
        clients_dir = harness.feedback_root / "data" / "sender_control" / "clients"
        clients_dir.mkdir(parents=True, exist_ok=True)
        slug = "lab_pc_parity"
        client_file = clients_dir / f"{slug}.json"
        client_file.write_text(
            json.dumps(
                {
                    "client_slug": slug,
                    "overrides": {
                        "verifyMode": "api",
                        "snapshotPolicy": "always",
                        "searchWait": 2.5,
                    },
                    "note": "单机云控互操作测试",
                    "updated_at": "2026-11-21 19:00:00",
                    "commands": [],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        def check_pull(engine: str, resp: HttpResponse, _: list[RecordedVisionRequest], __: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] sender_control_pull status")
            body = resp.json()
            assert_eq(body.get("success"), True, f"[{engine}] success")
            cc = body["data"]["cloud_control"]
            assert_eq(cc["client_slug"], slug, f"[{engine}] client_slug")
            assert_eq(cc["has_client_override"], True, f"[{engine}] has_client_override")
            assert_eq(cc["client_overrides"]["verifyMode"], "api", f"[{engine}] override verifyMode=api")
            assert_eq(cc["client_overrides"]["snapshotPolicy"], "always", f"[{engine}] override snapshotPolicy=always")
            assert_eq(cc["effective_policy"]["verifyMode"], "api", f"[{engine}] effective verifyMode=api")
            assert_eq(cc["effective_policy"]["snapshotPolicy"], "always", f"[{engine}] effective snapshotPolicy=always")
            assert_eq(float(cc["effective_policy"]["searchWait"]), 2.5, f"[{engine}] effective searchWait=2.5")

        # GET sender_control_pull
        harness.execute_across_engines(
            "logs_sender_control_pull_get",
            lambda u: http_request(
                u,
                "GET",
                f"/api/logs.php?action=sender_control_pull&client_slug={slug}&token={TEST_SENDER_TOKEN}",
            ),
            check_pull,
        )

        # POST sender_control_pull
        pull_post_body = json.dumps(
            {"token": TEST_SENDER_TOKEN, "client": {"client_slug": slug, "hostname": "LabPC", "os_user": "teacher"}}
        ).encode("utf-8")
        harness.execute_across_engines(
            "logs_sender_control_pull_post",
            lambda u: http_request(
                u,
                "POST",
                "/api/logs.php?action=sender_control_pull",
                headers={"Content-Type": "application/json"},
                body=pull_post_body,
            ),
            check_pull,
        )

        # POST sender_sync chunk mode (use offset=0 and identical content so PHP and Go both see size=14)
        chunk_body = json.dumps(
            {
                "token": TEST_SENDER_TOKEN,
                "sync_mode": "chunk",
                "date_str": "2026-11-21",
                "log_type": "sender",
                "offset": 0,
                "content": "parity line 1\n",
                "client": {"client_slug": slug, "hostname": "LabPC", "os_user": "teacher"},
            }
        ).encode("utf-8")
        harness.execute_across_engines(
            "logs_sender_sync_chunk",
            lambda u: http_request(
                u,
                "POST",
                "/api/logs.php?action=sender_sync",
                headers={"Content-Type": "application/json"},
                body=chunk_body,
            ),
            lambda e, r, _, __: (
                assert_eq(r.status, 200, f"[{e}] sender_sync chunk status"),
                assert_eq(r.json()["data"]["mode"], "chunk", f"[{e}] chunk mode"),
                assert_eq(r.json()["data"]["size"], 14, f"[{e}] chunk size"),
                assert_eq(r.json()["data"]["cloud_control"]["effective_policy"]["verifyMode"], "api", f"[{e}] cloud_control"),
            ),
        )

        # POST sender_sync batch_summary mode
        summary_body = json.dumps(
            {
                "token": TEST_SENDER_TOKEN,
                "sync_mode": "batch_summary",
                "client": {"client_slug": slug, "hostname": "LabPC", "os_user": "teacher"},
                "batch_summary": {
                    "date_str": "2026-11-21",
                    "counts": {"total": 2, "sent": 2, "failed": 0, "blocked": 0, "unmatched": 0, "skipped": 0},
                    "files": ["batch1.json"],
                    "stopped": False,
                    "students": [{"name": "张三", "status": "sent"}],
                },
            }
        ).encode("utf-8")
        harness.execute_across_engines(
            "logs_sender_sync_batch_summary",
            lambda u: http_request(
                u,
                "POST",
                "/api/logs.php?action=sender_sync",
                headers={"Content-Type": "application/json"},
                body=summary_body,
            ),
            lambda e, r, _, __: (
                assert_eq(r.status, 200, f"[{e}] sender_sync batch_summary status"),
                assert_eq(r.json()["data"]["mode"], "batch_summary", f"[{e}] batch_summary mode"),
            ),
        )

        # Unauthenticated GET list / stats / filters -> 401
        expected_unauth = {"success": False, "data": None, "error": "未登录或会话已过期，需管理员权限"}
        for act in ("list", "stats", "filters"):
            harness.execute_across_engines(
                f"logs_unauth_{act}_401",
                lambda u, a=act: http_request(u, "GET", f"/api/logs.php?action={a}"),
                lambda e, r, _, __, a=act: (
                    assert_eq(r.status, 401, f"[{e}] logs {a} unauth status"),
                    assert_json_values_match(expected_unauth, r.json(), f"[{e}] logs {a} unauth"),
                ),
            )

    # 35. admin.php check (loggedIn:false), unauth actions (401), and strict cross-origin POST CSRF (403)
    def test_admin_check_unauth_and_csrf() -> None:
        harness.execute_across_engines(
            "admin_check_logged_out",
            lambda u: http_request(u, "GET", "/api/admin.php?action=check"),
            lambda e, r, _, __: (
                assert_eq(r.status, 200, f"[{e}] admin check status"),
                assert_json_values_match(
                    {"success": True, "data": {"loggedIn": False}, "error": None},
                    r.json(),
                    f"[{e}] admin check JSON",
                ),
            ),
        )

        expected_unauth = {"success": False, "data": None, "error": "未登录或会话已过期，需管理员权限"}
        for method, act, body in [
            ("GET", "db_tables", None),
            ("GET", "config", None),
            ("GET", "db_list&table=student_records", None),
            ("POST", "change_password", b"{}"),
        ]:
            harness.execute_across_engines(
                f"admin_unauth_{act.split('&')[0]}_401",
                lambda u, m=method, a=act, b=body: http_request(u, m, f"/api/admin.php?action={a}", body=b),
                lambda e, r, _, __, a=act: (
                    assert_eq(r.status, 401, f"[{e}] admin {a} unauth status"),
                    assert_json_values_match(expected_unauth, r.json(), f"[{e}] admin {a} unauth"),
                ),
            )

        # Cross-origin POST CSRF rejected with 403 (both evil origin and cross-subdomain origin)
        for origin in ("https://evil.example", "https://vip.wxjifang.cn"):
            harness.execute_across_engines(
                f"admin_csrf_post_403_{origin.split('//')[1]}",
                lambda u, o=origin: http_request(
                    u,
                    "POST",
                    "/api/admin.php?action=logout",
                    headers={"Origin": o},
                ),
                lambda e, r, _, __, o=origin: (
                    assert_eq(r.status, 403, f"[{e}:{o}] admin CSRF status"),
                    assert_cors_headers(e, o, r),
                ),
                origin=origin,
            )

    # 36. retest.php SVG captcha, download_file 400/404, and unauth teacher/download actions (401)
    def test_retest_captcha_download_and_unauth() -> None:
        reset_baseline()

        # GET ?action=captcha -> 200 image/svg+xml
        def check_svg(engine: str, resp: HttpResponse, _: list[RecordedVisionRequest], __: set[str]) -> None:
            assert_eq(resp.status, 200, f"[{engine}] retest captcha status")
            assert_true("image/svg+xml" in resp.headers.get("content-type", "").lower(), f"[{engine}] SVG Content-Type")
            assert_true("<svg" in resp.text and "</svg>" in resp.text, f"[{engine}] SVG body")

        harness.execute_across_engines(
            "retest_captcha_svg",
            lambda u: http_request(u, "GET", "/api/retest.php?action=captcha"),
            check_svg,
            expect_json=False,
            check_cache_control=True,
        )

        # GET ?action=download_file&key=invalid -> 400
        harness.execute_across_engines(
            "retest_download_file_invalid_key_400",
            lambda u: http_request(u, "GET", "/api/retest.php?action=download_file&key=invalid"),
            lambda e, r, _, __: (
                assert_eq(r.status, 400, f"[{e}] invalid key status"),
                assert_eq(r.text, "无效的文件凭证（Invalid Key）", f"[{e}] invalid key message"),
            ),
            expect_json=False,
        )

        # GET ?action=download_file&key=0123456789abcdef0123456789abcdef -> 404
        harness.execute_across_engines(
            "retest_download_file_missing_key_404",
            lambda u: http_request(
                u, "GET", "/api/retest.php?action=download_file&key=0123456789abcdef0123456789abcdef"
            ),
            lambda e, r, _, __: (
                assert_eq(r.status, 404, f"[{e}] missing key status"),
                assert_eq(r.text, "文件不存在或已过期，请返回页面重新生成", f"[{e}] missing key message"),
            ),
            expect_json=False,
        )

        # Unauthenticated check_existing_batch & encrypt_batch -> 401
        expected_auth_401 = {"success": False, "data": None, "error": "未登录或登录会话已过期，请重新登录"}
        for act in ("check_existing_batch", "encrypt_batch"):
            harness.execute_across_engines(
                f"retest_unauth_{act}_401",
                lambda u, a=act: http_request(
                    u,
                    "POST",
                    f"/api/retest.php?action={a}",
                    headers={"Content-Type": "application/json"},
                    body=b"{}",
                ),
                lambda e, r, _, __, a=act: (
                    assert_eq(r.status, 401, f"[{e}] retest {a} unauth status"),
                    assert_json_values_match(expected_auth_401, r.json(), f"[{e}] retest {a} unauth"),
                ),
            )

        # Unauthenticated create_temp_download -> 401
        harness.execute_across_engines(
            "retest_unauth_create_temp_download_401",
            lambda u: http_request(u, "POST", "/api/retest.php?action=create_temp_download", body=b"%PDF-1.4\n"),
            lambda e, r, _, __: (
                assert_eq(r.status, 401, f"[{e}] create_temp_download unauth status"),
                assert_json_values_match(
                    {"success": False, "error": "未授权的下载请求：请先通过学生身份验证"},
                    r.json(),
                    f"[{e}] create_temp_download unauth",
                ),
            ),
        )

    tests: list[tuple[str, Callable[[], None]]] = [
        ("public_config_defaults", test_public_config_defaults),
        ("public_config_clamped_and_no_secrets", test_public_config_clamped_and_no_secrets),
        ("public_config_live_update", test_public_config_live_update),
        ("public_config_options_cors_allowed_exact", make_options_test("https://feedback.wxjifang.cn")),
        ("public_config_options_cors_allowed_subdomain", make_options_test("https://preview.wxjifang.cn")),
        ("public_config_options_cors_disallowed", make_options_test("https://evil.example")),
        ("calibrate_csrf_origin_mismatch", test_calibrate_csrf_origin_mismatch),
        ("calibrate_csrf_referer_mismatch", test_calibrate_csrf_referer_mismatch),
        ("calibrate_get_ready", test_calibrate_get_ready),
        ("calibrate_delete_405", test_calibrate_delete_405),
        ("calibrate_bad_tokens", test_calibrate_bad_tokens),
        ("calibrate_bearer_auth_and_missing_image", test_calibrate_bearer_auth_and_missing_image),
        ("calibrate_non_image_400", test_calibrate_non_image_400),
        ("calibrate_small_10x10_200", test_calibrate_small_10x10_200),
        ("calibrate_disabled_gate", test_calibrate_disabled_gate),
        ("calibrate_valid_think_and_coords", test_calibrate_valid_think_and_coords),
        ("calibrate_upstream_errors_and_invalid_json", test_calibrate_upstream_errors_and_invalid_json),
        ("identify_get_405", test_identify_get_405),
        ("identify_validation_and_auth", test_identify_validation_and_auth),
        ("identify_admin_gates", test_identify_admin_gates),
        ("identify_full_strict_bool_and_archive", test_identify_full_strict_bool_and_archive),
        ("identify_title_and_benchmark_and_archive", test_identify_title_and_benchmark_and_archive),
        ("identify_reply_mode_and_archive", test_identify_reply_mode_and_archive),
        ("identify_sidebar_mode_and_archive", test_identify_sidebar_mode_and_archive),
        ("identify_upstream_errors_and_non_json", test_identify_upstream_errors_and_non_json),
        ("changelog_public_and_unauth", test_changelog_public_and_unauth),
        ("upload_pdf_unauth_401", test_upload_pdf_unauth_401),
        ("upload_capture_unauth_401", test_upload_capture_unauth_401),
        ("ai_secrets_json_isolation", test_ai_secrets_json_isolation),
        ("multi_sender_tokens_and_strict_no_default", test_multi_sender_tokens_and_strict_no_default),
        ("jpeg_upload_and_forwarded_ip_headers", test_jpeg_upload_and_forwarded_ip_headers),
        ("auth_endpoints_parity", test_auth_endpoints_parity),
        ("qbank_unauth_401", test_qbank_unauth_401),
        ("logs_sender_control_sync_and_unauth", test_logs_sender_control_sync_and_unauth),
        ("admin_check_unauth_and_csrf", test_admin_check_unauth_and_csrf),
        ("retest_captcha_download_and_unauth", test_retest_captcha_download_and_unauth),
    ]

    for name, fn in tests:
        harness.run_test(name, fn)


def prepare_isolated_feedback_root(temp_dir: Path, source_feedback_v1: Path, mock_port: int) -> Path:
    """Create an isolated temporary copy of feedback-v1/api and controlled secrets."""
    src_api = source_feedback_v1 / "api"
    if not src_api.is_dir():
        raise FileNotFoundError(f"Source feedback-v1/api not found at {src_api}")

    root = temp_dir / "feedback-v1"
    root.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src_api, root / "api")
    (root / "data" / "identify_archive").mkdir(parents=True, exist_ok=True)

    secret_local = root / "api" / "secret_key.local.php"
    secret_local.write_text(
        "<?php\n"
        "return [\n"
        f"    'retestSecret' => '{TEST_RETEST_SECRET}',\n"
        f"    'senderApiToken' => '{TEST_SENDER_TOKEN}',\n"
        f"    'dashscopeApiKey' => '{TEST_VISION_KEY}',\n"
        f"    'identifyApiBase' => 'http://127.0.0.1:{mock_port}/v1',\n"
        "    'identifyModel' => 'mock-vision-max',\n"
        "    'identifyFastModel' => 'mock-vision-flash',\n"
        "];\n",
        encoding="utf-8",
    )

    # Isolate DB config to an unreachable port so no-DB parity tests never hit a live MySQL instance
    db_local = root / "api" / "db.local.php"
    db_local.write_text(
        "<?php\n"
        "return [\n"
        "    'host' => '127.0.0.1',\n"
        "    'port' => 1,\n"
        "    'dbname' => 'feedback_parity_offline',\n"
        "    'username' => 'nobody',\n"
        "    'password' => '',\n"
        "];\n",
        encoding="utf-8",
    )
    return root


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Differential parity test suite comparing PHP feedback-v1 API and Go feedback-api."
    )
    parser.add_argument("--go-bin", help="Path to compiled Go feedback-api binary")
    parser.add_argument(
        "--php-only",
        action="store_true",
        help="Run test suite against local PHP built-in server only",
    )
    parser.add_argument(
        "--php-bin",
        default="php",
        help="Path to PHP CLI binary (default: php)",
    )
    args = parser.parse_args(argv)
    if not args.php_only and not args.go_bin:
        parser.error("Must specify either --go-bin <path> or --php-only")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    repo_root = Path(__file__).resolve().parents[2]
    source_feedback_v1 = repo_root / "feedback-v1"

    php_path = shutil.which(args.php_bin) or args.php_bin
    if not shutil.which(php_path) and not Path(php_path).is_file():
        print(f"ERROR: PHP binary not found: {args.php_bin}", file=sys.stderr)
        return 2

    go_bin_path: str | None = None
    if not args.php_only and args.go_bin:
        resolved_go = Path(args.go_bin).resolve()
        if not resolved_go.is_file():
            print(f"ERROR: Go binary not found: {args.go_bin}", file=sys.stderr)
            return 2
        go_bin_path = str(resolved_go)

    mock = MockVisionServer()
    mock.start()
    php_proc: subprocess.Popen[bytes] | None = None
    go_proc: subprocess.Popen[bytes] | None = None

    try:
        with tempfile.TemporaryDirectory(prefix="feedback_parity_") as tmp:
            tmp_path = Path(tmp)
            feedback_root = prepare_isolated_feedback_root(tmp_path, source_feedback_v1, mock.port)

            php_port = alloc_free_port()
            go_port = alloc_free_port()
            while go_port == php_port:
                go_port = alloc_free_port()

            base_env = clean_subprocess_env()
            php_env = base_env.copy()
            php_env["FEEDBACK_SESSION_DRIVER"] = "files"
            php_log = tmp_path / "php.log"
            go_log = tmp_path / "go.log"

            php_cmd = [
                php_path,
                "-d",
                "date.timezone=Asia/Shanghai",
                "-d",
                "upload_max_filesize=20M",
                "-d",
                "post_max_size=25M",
                "-S",
                f"127.0.0.1:{php_port}",
                "-t",
                str(feedback_root),
            ]
            with php_log.open("wb") as php_log_f:
                php_proc = subprocess.Popen(
                    php_cmd,
                    stdout=php_log_f,
                    stderr=subprocess.STDOUT,
                    env=php_env,
                )
            php_url = f"http://127.0.0.1:{php_port}"
            wait_for_server(php_proc, php_log, php_url, "/api/calibrate_roi.php", "php -S")

            go_url: str | None = None
            if go_bin_path:
                go_env = base_env.copy()
                go_env["FEEDBACK_ROOT"] = str(feedback_root)
                go_env["FEEDBACK_LISTEN_ADDR"] = f"127.0.0.1:{go_port}"
                with go_log.open("wb") as go_log_f:
                    go_proc = subprocess.Popen(
                        [go_bin_path],
                        stdout=go_log_f,
                        stderr=subprocess.STDOUT,
                        env=go_env,
                    )
                go_url = f"http://127.0.0.1:{go_port}"
                wait_for_server(go_proc, go_log, go_url, "/healthz", "feedback-api (Go)")

            mode_label = "php-only" if go_url is None else f"php-vs-go ({go_bin_path})"
            print(f"Running parity suite [{mode_label}] | mock=127.0.0.1:{mock.port} | php={php_url}" + (f" | go={go_url}" if go_url else ""))

            harness = ParityHarness(feedback_root, mock, php_url, go_url)
            register_and_run_all_tests(harness)

            passed = sum(1 for _, ok, _ in harness.results if ok)
            total = len(harness.results)
            failed = total - passed
            print(f"\nSummary: {passed}/{total} passed, {failed} failed ({mode_label})")
            return 0 if failed == 0 else 1
    finally:
        stop_process(go_proc)
        stop_process(php_proc)
        mock.stop()


if __name__ == "__main__":
    raise SystemExit(main())
