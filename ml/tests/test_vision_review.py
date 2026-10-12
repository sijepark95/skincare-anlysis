import copy
import unittest

from senmiva_training.vision_api import FEATURES, PINNED_MODEL
from senmiva_training.vision_review import build_report, render_report


def result(photo="p001", group="g001", *, remote="completed", value="visible", usage=True):
    return {"photo_id": photo, "participant_group": group,
            "local": {"status": "completed", "latency_ms": 10,
                      "heads": [{"key": key, "predicted_code": code} for key, code in zip(("sensitivity", "pigmentation", "wrinkles", "acne", "pores", "sagging", "keratin", "redness"), ("NS", "P0", "W0", "NA", "NVP", "NSA", "ND", "NR"))]},
            "openai": {"status": remote, "model": PINNED_MODEL, "latency_ms": 100,
                       "observations": {"image_quality": "not_assessable" if value == "not_assessable" else "usable", "quality_flags": ["blur"] if value == "not_assessable" else [], "observed_features": {key: value for key in FEATURES}} if remote == "completed" else None,
                       "usage": {"input_tokens": 1000, "output_tokens": 100, "total_tokens": 1100} if usage else None}}


def config(count):
    return {"evaluation_id": "pilot-001", "run_id": "paired-001", "photo_count": count}


class VisionReviewTests(unittest.TestCase):
    def test_no_results_never_becomes_accuracy_or_zero_cost(self):
        report = build_report(config(2), [])
        self.assertEqual(report["providers"]["openai"]["missing_or_interrupted"], 2)
        self.assertIsNone(report["providers"]["openai"]["estimated_uncached_usd_for_known_usage"])
        self.assertIsNone(report["decision"]["winner"])
        self.assertFalse(report["decision"]["accuracy_comparison_available"])
        self.assertFalse(report["decision"]["production_switch_authorized"])

    def test_actual_usage_rates_not_multiplied_by_image_factor(self):
        report = build_report(config(1), [result()])
        self.assertEqual(report["providers"]["openai"]["estimated_uncached_usd_for_known_usage"], .00056)

    def test_refusal_failure_and_missing_usage_remain_in_denominator(self):
        rows = [result(), result("p002", remote="refused", usage=False), result("p003", remote="unavailable", usage=False)]
        report = build_report(config(4), rows)
        value = report["providers"]["openai"]
        self.assertEqual(value["completion_rate_all_photos"], .25)
        self.assertEqual((value["completed"], value["refused"], value["unavailable"], value["missing_or_interrupted"]), (1, 1, 1, 1))
        self.assertEqual(value["token_usage"]["responses_without_usage"], 2)

    def test_participants_receive_equal_weight_in_capture_agreement(self):
        # Group one: 3 identical captures. Group two: 2 different captures.
        rows = [result("p001"), result("p002"), result("p003"), result("p004", "g002"), result("p005", "g002", value="not_visible")]
        report = build_report(config(5), rows)
        stability = report["providers"]["openai"]["within_participant_capture_agreement"]
        self.assertEqual(stability["mean_participant_exact_agreement"], .5)
        self.assertEqual(stability["capture_pairs"], 4)
        self.assertEqual(stability["participant_groups_compared"], 2)

    def test_abstentions_not_counted_as_reliable_repeat_agreement(self):
        rows = [result(), result("p002", value="not_assessable")]
        report = build_report(config(2), rows)
        self.assertIsNone(report["providers"]["openai"]["within_participant_capture_agreement"]["mean_participant_exact_agreement"])
        self.assertEqual(report["providers"]["openai"]["feature_value_counts"][FEATURES[0]]["not_assessable"], 1)

    def test_report_is_aggregate_does_not_mutate_or_expose_identifiers(self):
        rows = [result("private_photo_id", "private_person_id")]
        before = copy.deepcopy(rows)
        report = build_report(config(1), rows)
        text = str(report) + render_report(report)
        self.assertNotIn("private_photo_id", text)
        self.assertNotIn("private_person_id", text)
        self.assertEqual(rows, before)

    def test_invalid_counts_duplicates_and_measurements_fail_closed(self):
        bad = result()
        bad["openai"]["latency_ms"] = float("nan")
        for cfg, rows in ((config(0), [result()]), (config(2), [result(), result()]), (config(True), []), (config(1), [bad])):
            with self.subTest(cfg=cfg), self.assertRaises(ValueError):
                build_report(cfg, rows)

    def test_unknown_model_and_invented_observations_rejected(self):
        for field, value in (("model", "future-model"), ("usage", {"input_tokens": True, "output_tokens": 1, "total_tokens": 2})):
            row = result()
            row["openai"][field] = value
            with self.assertRaises(ValueError):
                build_report(config(1), [row])
        row = result()
        row["openai"]["observations"]["observed_features"]["hydration"] = "visible"
        with self.assertRaises(ValueError):
            build_report(config(1), [row])

    def test_invalid_code_and_inconsistent_quality_rejected(self):
        row = result()
        row["local"]["heads"][0]["predicted_code"] = "CLINICAL"
        with self.assertRaises(ValueError):
            build_report(config(1), [row])
        row = result()
        row["openai"]["observations"]["image_quality"] = "not_assessable"
        with self.assertRaises(ValueError):
            build_report(config(1), [row])

    def test_render_shows_unknown_attempts_and_no_direct_stability_comparison(self):
        report = build_report(config(1), [])
        report["attempt_journal"] = {"claimed": 1, "finished": 0, "uncertain": 1}
        text = render_report(report)
        self.assertIn("종료 미확인 1건", text)
        self.assertIn("직접 비교할 수 없습니다", text)
        self.assertNotIn("None", text)


if __name__ == "__main__":
    unittest.main()
