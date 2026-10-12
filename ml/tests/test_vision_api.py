from __future__ import annotations

import base64
import copy
import io
import json
import unittest
from unittest.mock import patch
import urllib.error

from senmiva_training import vision_api as api


KEY = "sk-" + "synthetic" * 4


def jpeg(width=224, height=224):
    # Header-only in-memory synthetic bytes for boundary tests; no person image.
    def segment(marker, payload):
        return bytes([255, marker]) + (len(payload) + 2).to_bytes(2, "big") + payload
    return (b"\xff\xd8"
            + segment(0xE0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")
            + segment(0xC0, b"\x08" + height.to_bytes(2, "big")
                      + width.to_bytes(2, "big") + b"\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00")
            + segment(0xDA, b"\x03\x01\x00\x02\x11\x03\x11\x00\x3f\x00")
            + b"synthetic\xff\x00pixel\xff\xd0data\xff\xd9")


def observations():
    return {
        "image_quality": "usable",
        "quality_flags": [],
        "observed_features": {feature: "not_visible" for feature in api.FEATURES},
    }


def envelope(value=None):
    return {
        "model": api.PINNED_MODEL,
        "status": "completed",
        "output": [{
            "type": "message", "role": "assistant", "status": "completed",
            "content": [{"type": "output_text", "text": json.dumps(value or observations()),
                         "annotations": []}],
        }],
        "usage": {"input_tokens": 100, "output_tokens": 40, "total_tokens": 140},
    }


class FakeResponse:
    def __init__(self, value=None, *, raw=None, headers=None, status=200, url=api.ENDPOINT):
        self.data = io.BytesIO(raw if raw is not None else json.dumps(value or envelope()).encode())
        self.headers = {"Content-Type": "application/json", **(headers or {})}
        self.status = status
        self.url = url
        self.closed = False

    def geturl(self):
        return self.url

    def read1(self, size):
        return self.data.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True


class VisionProtocolTests(unittest.TestCase):
    def test_exact_appearance_protocol_and_explicit_inability(self):
        value = observations()
        self.assertEqual(api.validate_observations(value), value)
        value.update(image_quality="limited", quality_flags=["blur"])
        value["observed_features"]["visible_pores"] = "uncertain"
        self.assertEqual(api.validate_observations(value), value)
        value.update(image_quality="not_assessable", quality_flags=["no_face"])
        value["observed_features"] = dict.fromkeys(api.FEATURES, "not_assessable")
        self.assertEqual(api.validate_observations(value), value)

    def test_protocol_does_not_mutate_or_share_source_containers(self):
        source = observations()
        result = api.validate_observations(source)
        result["quality_flags"].append("blur")
        result["observed_features"]["visible_pores"] = "visible"
        self.assertEqual(source, observations())

    def test_rejects_extra_claims_labels_numeric_scores_and_quality_contradictions(self):
        values = [None, [], {}, {**observations(), "diagnosis": "private provider text"}]
        for name, value in (
            ("unknown_quality", "healthy"), ("numeric_quality", 0.9),
        ):
            candidate = observations()
            candidate["image_quality"] = value
            values.append(candidate)
        for value in ("severe", 0.9, {}, None, "P2"):
            candidate = observations()
            candidate["observed_features"]["visible_spots"] = value
            values.append(candidate)
        for flags in (["clinical"], ["blur", "blur"], [None], ["no_face"], ["blur"]):
            candidate = observations()
            candidate["quality_flags"] = flags
            values.append(candidate)
        candidate = observations()
        candidate["observed_features"].pop("visible_redness")
        values.append(candidate)
        candidate = observations()
        candidate["observed_features"]["hydration"] = "visible"
        values.append(candidate)
        for quality in ("limited", "not_assessable"):
            candidate = observations()
            candidate["image_quality"] = quality
            values.append(candidate)
        candidate = observations()
        candidate.update(image_quality="not_assessable", quality_flags=["blur"])
        values.append(candidate)
        for index, value in enumerate(values):
            with self.subTest(index=index), self.assertRaisesRegex(ValueError, "could not be verified"):
                api.validate_observations(value)


class VisionApiTests(unittest.TestCase):
    def test_fresh_pillow_rgb_encoding_matches_the_adapter_contract(self):
        from PIL import Image
        buffer = io.BytesIO()
        Image.new("RGB", (640, 480), (128, 96, 160)).save(
            buffer, format="JPEG", quality=90, subsampling=0,
            optimize=False, progressive=False,
        )
        with patch.object(api, "_open_response", return_value=FakeResponse()) as send:
            result = api.VisionApiClient(KEY).analyze(buffer.getvalue())
        self.assertEqual(result.status, "completed")
        send.assert_called_once()

    def test_fixed_endpoint_minimized_request_and_actual_sanitized_usage(self):
        response = FakeResponse()
        with patch.object(api, "_open_response", return_value=response) as send:
            result = api.VisionApiClient(KEY).analyze(jpeg())
        self.assertTrue(response.closed)
        request, timeout = send.call_args.args
        self.assertEqual(request.full_url, api.ENDPOINT)
        self.assertEqual(request.method, "POST")
        self.assertEqual(timeout, 30)
        self.assertEqual(request.get_header("Authorization"), "Bearer " + KEY)
        body = json.loads(request.data)
        self.assertEqual(set(body), {"model", "instructions", "input", "store", "temperature",
                                     "max_output_tokens", "text"})
        self.assertFalse(body["store"])
        self.assertEqual(body["model"], api.PINNED_MODEL)
        self.assertEqual(body["max_output_tokens"], 512)
        self.assertEqual(body["temperature"], 0)
        self.assertTrue(body["text"]["format"]["strict"])
        self.assertEqual(body["text"]["format"]["schema"], api.OUTPUT_SCHEMA)
        content = body["input"][0]["content"]
        self.assertEqual(content[0], {"type": "input_text", "text": "Observe only the allowed visible features."})
        self.assertEqual(set(content[1]), {"type", "image_url", "detail"})
        self.assertEqual(content[1]["detail"], "high")
        self.assertEqual(base64.b64decode(content[1]["image_url"].split(",", 1)[1]), jpeg())
        self.assertNotIn(KEY, request.data.decode())
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.observations, observations())
        self.assertEqual(result.usage.to_dict(), {"input_tokens": 100, "output_tokens": 40, "total_tokens": 140})
        self.assertGreaterEqual(result.latency_ms, 0)
        exported = result.to_dict()
        self.assertEqual(set(exported), {"status", "model", "prompt_version", "observations", "usage", "latency_ms", "failure_kind"})
        self.assertNotIn("image", json.dumps(exported).replace("image_quality", ""))
        self.assertNotIn(KEY, json.dumps(exported))
        send.assert_called_once()

    def test_refusal_is_explicit_and_provider_free_text_is_discarded(self):
        value = envelope()
        value["output"][0]["content"] = [{"type": "refusal", "refusal": "private refusal " + KEY}]
        with patch.object(api, "_open_response", return_value=FakeResponse(value)):
            result = api.VisionApiClient(KEY).analyze(jpeg())
        self.assertEqual(result.status, "refused")
        self.assertIsNone(result.observations)
        self.assertEqual(result.usage.total_tokens, 140)
        self.assertNotIn("private refusal", json.dumps(result.to_dict()))
        self.assertNotIn(KEY, json.dumps(result.to_dict()))

    def test_unassessable_is_distinct_from_absence_of_visible_features(self):
        value = observations()
        value.update(image_quality="not_assessable", quality_flags=["multiple_faces"])
        value["observed_features"] = dict.fromkeys(api.FEATURES, "not_assessable")
        with patch.object(api, "_open_response", return_value=FakeResponse(envelope(value))):
            result = api.VisionApiClient(KEY).analyze(jpeg())
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.observations, value)

    def test_missing_usage_is_unknown_not_fake_zero(self):
        value = envelope()
        value.pop("usage")
        with patch.object(api, "_open_response", return_value=FakeResponse(value)):
            result = api.VisionApiClient(KEY).analyze(jpeg())
        self.assertEqual(result.status, "completed")
        self.assertIsNone(result.usage)

    def test_unsupported_configuration_never_sends(self):
        cases = [dict(model="gpt-4.1-mini"), dict(model="another-model"),
                 dict(timeout_seconds=31), dict(timeout_seconds=0),
                 dict(timeout_seconds=True), dict(timeout_seconds=float("nan"))]
        with patch.object(api, "_open_response") as send:
            for options in cases:
                with self.subTest(options=options), self.assertRaises(ValueError):
                    api.VisionApiClient(KEY, **options)
            for key in (None, "", "Bearer " + KEY, KEY + "\n", "private"):
                with self.subTest(key=key), self.assertRaises(ValueError):
                    api.VisionApiClient(key)
            send.assert_not_called()

    def test_rejects_metadata_unbounded_non_rgb_and_trailing_inputs_before_network(self):
        values = [b"", bytearray(jpeg()), b"not a jpeg", jpeg(223, 224), jpeg(224, 1537),
                  jpeg() + b"private trailing text", b"\xff\xd8" + b"a" * api.MAX_IMAGE_BYTES + b"\xff\xd9"]
        for marker in (0xE1, 0xE2, 0xED, 0xFE):
            values.append(jpeg()[:2] + bytes([255, marker, 0, 4]) + b"PI" + jpeg()[2:])
        grayscale = jpeg().replace(b"\x08\x00\xe0\x00\xe0\x03", b"\x08\x00\xe0\x00\xe0\x01", 1)
        values.append(grayscale)
        with patch.object(api, "_open_response") as send:
            for index, value in enumerate(values):
                with self.subTest(index=index), self.assertRaisesRegex(ValueError, "sanitized RGB JPEG"):
                    api.VisionApiClient(KEY).analyze(value)
            send.assert_not_called()

    def test_invalid_envelopes_and_output_are_safe_unavailable_results(self):
        values = []
        for field, invalid in (("model", "other"), ("status", "incomplete"),
                               ("error", {"message": KEY}), ("incomplete_details", {"reason": "max_output_tokens"}),
                               ("output", []), ("usage", {"input_tokens": True, "output_tokens": 1, "total_tokens": 2})):
            value = envelope()
            value[field] = invalid
            values.append(value)
        for mutation in (
            lambda v: v["output"].append(copy.deepcopy(v["output"][0])),
            lambda v: v["output"][0].update(role="user"),
            lambda v: v["output"][0]["content"][0].update(annotations=[{"text": KEY}]),
            lambda v: v["output"][0]["content"][0].update(text=json.dumps({**observations(), "diagnosis": KEY})),
            lambda v: v["output"][0]["content"].append({"type": "output_text", "text": KEY}),
        ):
            value = envelope()
            mutation(value)
            values.append(value)
        for index, value in enumerate(values):
            with self.subTest(index=index), patch.object(api, "_open_response", return_value=FakeResponse(value)) as send:
                result = api.VisionApiClient(KEY).analyze(jpeg())
                self.assertEqual(result.status, "unavailable")
                self.assertEqual(result.failure_kind, "invalid_response")
                self.assertIsNone(result.observations)
                if value.get("model") != api.PINNED_MODEL:
                    self.assertIsNone(result.usage)
                self.assertNotIn(KEY, json.dumps(result.to_dict()))
                send.assert_called_once()

    def test_rejects_duplicate_json_keys_invalid_utf8_and_non_json(self):
        for raw in (b'{"status":"completed","status":"completed"}', b'{"value":NaN}', b"\xff", b"private body"):
            with self.subTest(raw=raw), patch.object(api, "_open_response", return_value=FakeResponse(raw=raw)):
                result = api.VisionApiClient(KEY).analyze(jpeg())
                self.assertEqual(result.failure_kind, "invalid_response")

    def test_response_size_type_and_redirect_bounds(self):
        cases = [
            FakeResponse(raw=b"a" * (api.MAX_RESPONSE_BYTES + 1)),
            FakeResponse(headers={"Content-Length": str(api.MAX_RESPONSE_BYTES + 1)}),
            FakeResponse(headers={"Content-Length": "unknown"}),
            FakeResponse(headers={"Content-Type": "text/html"}),
            FakeResponse(url="https://untrusted.example/"),
            FakeResponse(status=302),
        ]
        for response in cases:
            with self.subTest(response=response), patch.object(api, "_open_response", return_value=response) as send:
                result = api.VisionApiClient(KEY).analyze(jpeg())
                self.assertEqual(result.failure_kind, "invalid_response")
                self.assertTrue(response.closed)
                send.assert_called_once()

    def test_network_errors_are_sanitized_and_never_retried(self):
        for error, expected in (
            (TimeoutError(KEY), "timeout"),
            (urllib.error.URLError(KEY), "transport_error"),
            (RuntimeError(KEY), "transport_error"),
            (urllib.error.HTTPError(api.ENDPOINT, 401, KEY, {}, io.BytesIO(KEY.encode())), "authentication"),
            (urllib.error.HTTPError(api.ENDPOINT, 429, KEY, {}, io.BytesIO(KEY.encode())), "rate_limit_or_quota"),
            (urllib.error.HTTPError(api.ENDPOINT, 500, KEY, {}, io.BytesIO(KEY.encode())), "http_error"),
        ):
            with self.subTest(expected=expected), patch.object(api, "_open_response", side_effect=error) as send:
                result = api.VisionApiClient(KEY).analyze(jpeg())
                self.assertEqual(result.failure_kind, expected)
                self.assertEqual(result.status, "unavailable")
                self.assertNotIn(KEY, json.dumps(result.to_dict()))
                send.assert_called_once()

    def test_total_read_deadline_is_checked_even_for_successful_http(self):
        with patch.object(api, "_open_response", return_value=FakeResponse()) as send:
            with patch.object(api.time, "monotonic", side_effect=[100, 100, 131, 131]):
                result = api.VisionApiClient(KEY).analyze(jpeg())
        self.assertEqual(result.failure_kind, "timeout")
        self.assertEqual(result.latency_ms, 31000)
        send.assert_called_once()

    def test_redirect_handler_refuses_and_opener_disables_environment_proxies(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            api._NoRedirect().redirect_request(None, None, 307, "private", {}, "https://untrusted.example/")
        self.assertNotIn("untrusted", str(caught.exception))
        with patch.object(api.urllib.request, "build_opener") as build:
            request = api.urllib.request.Request(api.ENDPOINT)
            api._open_response(request, 5)
            handlers = build.call_args.args
            self.assertEqual(handlers[0].proxies, {})
            self.assertIsInstance(handlers[1], api._NoRedirect)
            self.assertIsInstance(handlers[2], api.urllib.request.HTTPSHandler)
            build.return_value.open.assert_called_once_with(request, timeout=5)


if __name__ == "__main__":
    unittest.main()
