"""Pure metric tests deliberately require no PyTorch, image, or real dataset."""

import json
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from senmiva_training.trainer import confusion_metrics, train_model


class ConfusionMetricsTests(unittest.TestCase):
    def test_confusion_and_balanced_accuracy_expose_majority_failure(self):
        result = confusion_metrics([0, 0, 1, 1, 1, 1, 1, 1, 1, 1], [1] * 10)
        self.assertEqual(result["confusion_matrix"], [[0, 2], [0, 8]])
        self.assertEqual(result["accuracy"], 0.8)
        self.assertEqual(result["balanced_accuracy"], 0.5)
        self.assertAlmostEqual(result["macro_f1"], 4 / 9)
        self.assertEqual(result["per_class"]["NVP"]["recall"], 0)
        self.assertIsNone(result["per_class"]["NVP"]["precision"])
        self.assertTrue(result["all_true_classes_present"])

    def test_perfect_binary_predictions(self):
        result = confusion_metrics([0, 1, 1, 0], [0, 1, 1, 0])
        self.assertEqual(result["confusion_matrix"], [[2, 0], [0, 2]])
        self.assertEqual(result["accuracy"], 1)
        self.assertEqual(result["balanced_accuracy"], 1)
        self.assertEqual(result["macro_f1"], 1)
        self.assertEqual(result["per_class"]["NVP"]["support"], 2)

    def test_missing_true_class_is_explicit(self):
        result = confusion_metrics([1, 1], [0, 1])
        self.assertIsNone(result["per_class"]["NVP"]["recall"])
        self.assertEqual(result["per_class"]["NVP"]["precision"], 0)
        self.assertEqual(result["balanced_accuracy"], 0.5)
        self.assertAlmostEqual(result["macro_f1"], 1 / 3)
        self.assertFalse(result["all_true_classes_present"])

    def test_empty_input_does_not_invent_a_score(self):
        result = confusion_metrics([], [])
        self.assertEqual(result["sample_count"], 0)
        self.assertEqual(result["confusion_matrix"], [[0, 0], [0, 0]])
        for key in ("accuracy", "balanced_accuracy", "macro_f1"):
            self.assertIsNone(result[key])
        self.assertFalse(result["all_true_classes_present"])
        json.dumps(result, allow_nan=False)

    def test_mismatched_lengths_are_rejected(self):
        with self.assertRaises(ValueError):
            confusion_metrics([0, 1], [0])

    def test_unknown_codes_and_non_integer_labels_are_rejected(self):
        for invalid in (-1, 2, "VP", None, True, 1.0):
            with self.subTest(label=invalid):
                with self.assertRaises(ValueError):
                    confusion_metrics([invalid], [0])
                with self.assertRaises(ValueError):
                    confusion_metrics([0], [invalid])

    def test_recall_uses_true_rows_not_prediction_columns(self):
        result = confusion_metrics([0, 0, 0, 1], [0, 1, 1, 1])
        self.assertAlmostEqual(result["per_class"]["NVP"]["recall"], 1 / 3)
        self.assertEqual(result["per_class"]["VP"]["recall"], 1)
        self.assertAlmostEqual(result["per_class"]["VP"]["precision"], 1 / 3)
        self.assertAlmostEqual(result["balanced_accuracy"], 2 / 3)


class TrainerPreflightTests(unittest.TestCase):
    """Fail unsafe experiments before loading Torch or writing artifacts."""

    @staticmethod
    def rows(split, labels):
        return [
            {
                "sample_id": hashlib.sha256(f"{split}-{index}".encode()).hexdigest(),
                "image_sha256": hashlib.sha256(f"image-{split}-{index}".encode()).hexdigest(),
                "split": split,
                "label": label,
                "grouping_verified": False,
            }
            for index, label in enumerate(labels)
        ]

    def call_with_rows(self, train, validation):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with patch("senmiva_training.data.load_manifest", side_effect=[train, validation]):
                with self.assertRaises(ValueError):
                    train_model(root / "manifests", root / "run")
            self.assertFalse((root / "run").exists())

    def test_one_class_validation_is_rejected_before_selection(self):
        self.call_with_rows(self.rows("train", ["NVP", "VP"]), self.rows("validation", ["VP", "VP"]))

    def test_cross_split_exact_duplicate_is_rejected(self):
        train = self.rows("train", ["NVP", "VP"])
        validation = self.rows("validation", ["NVP", "VP"])
        validation[0]["image_sha256"] = train[0]["image_sha256"]
        self.call_with_rows(train, validation)

    def test_cross_split_sample_identity_is_rejected(self):
        train = self.rows("train", ["NVP", "VP"])
        validation = self.rows("validation", ["NVP", "VP"])
        validation[0]["sample_id"] = train[0]["sample_id"]
        self.call_with_rows(train, validation)

    def test_one_class_training_is_rejected(self):
        self.call_with_rows(self.rows("train", ["VP", "VP"]), self.rows("validation", ["NVP", "VP"]))

    def test_invalid_manifest_digest_is_rejected(self):
        train = self.rows("train", ["NVP", "VP"])
        train[0]["image_sha256"] = "not-a-digest"
        self.call_with_rows(train, self.rows("validation", ["NVP", "VP"]))

    def test_windows_multiworker_request_is_explicitly_rejected(self):
        with self.assertRaisesRegex(ValueError, "workers=0"):
            train_model(Path("unused"), Path("unused-run"), workers=2)

    def test_frozen_random_backbone_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Random initialization"):
            train_model(Path("unused"), Path("unused-run"), pretrained=False)


if __name__ == "__main__":
    unittest.main()
