import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from senmiva_training.cli import child, main


class CliTests(unittest.TestCase):
    def test_explicit_workspace_works_without_windows_environment(self):
        with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, {}, clear=True):
            source, workspace = Path(temp) / "source", Path(temp) / "private"
            source.mkdir()
            with contextlib.redirect_stdout(io.StringIO()) as output:
                status = main(["--workspace", str(workspace), "init", "--source", str(source), "--training-permitted"])
            self.assertEqual(status, 0)
            self.assertTrue(json.loads(output.getvalue())["registered"])

    def test_unregistered_source_does_not_enter_data_adapter(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch("senmiva_training.data.prepare_dataset") as prepare, contextlib.redirect_stdout(io.StringIO()) as output:
                status = main(["--workspace", str(Path(temp) / "private"), "prepare"])
            self.assertEqual(status, 1)
            prepare.assert_not_called()
            self.assertNotIn(temp, output.getvalue())

    def test_run_names_cannot_escape_workspace(self):
        for name in ("../source", "C:\\secrets", "name/child", "", "..", "한글"):
            with self.assertRaises(ValueError):
                child(Path("C:/private"), "runs", name)

    def test_original_paths_in_upstream_errors_are_not_printed(self):
        with tempfile.TemporaryDirectory() as temp:
            source, workspace = Path(temp) / "source", Path(temp) / "private"
            source.mkdir()
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(["--workspace", str(workspace), "init", "--source", str(source), "--training-permitted"]), 0)
            with patch("senmiva_training.data.prepare_dataset", side_effect=OSError("private-person-record.jpg")), contextlib.redirect_stdout(io.StringIO()) as output:
                status = main(["--workspace", str(workspace), "prepare"])
            self.assertEqual(status, 1)
            self.assertNotIn("private-person", output.getvalue())

    def test_evaluate_dispatches_existing_checkpoint_without_training(self):
        with tempfile.TemporaryDirectory() as temp:
            source, workspace = Path(temp) / "source", Path(temp) / "private"
            source.mkdir()
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(["--workspace", str(workspace), "init", "--source", str(source), "--training-permitted"]), 0)
            with patch("senmiva_training.evaluation.evaluate_model", return_value={"independent_test": False}) as evaluate, patch("senmiva_training.trainer.train_model") as train, contextlib.redirect_stdout(io.StringIO()) as output:
                status = main(["--workspace", str(workspace), "evaluate", "--run", "head-001", "--device", "cpu", "--checkpoint", "last", "--batch-size", "4"])
            self.assertEqual(status, 0)
            evaluate.assert_called_once_with(workspace / "manifests" / "pores-clean-full", workspace / "runs" / "head-001", checkpoint="last", device="cpu", batch_size=4)
            train.assert_not_called()
            self.assertFalse(json.loads(output.getvalue())["independent_test"])

    def test_unregistered_source_cannot_enter_evaluation(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch("senmiva_training.evaluation.evaluate_model") as evaluate, contextlib.redirect_stdout(io.StringIO()) as output:
                status = main(["--workspace", str(Path(temp) / "private"), "evaluate", "--run", "head-001"])
            self.assertEqual(status, 1)
            evaluate.assert_not_called()
            self.assertNotIn(temp, output.getvalue())

    def test_expanded_dataset_commands_dispatch_only_the_requested_operation(self):
        with tempfile.TemporaryDirectory() as temp:
            source, workspace = Path(temp) / "source", Path(temp) / "private"
            source.mkdir()
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(["--workspace", str(workspace), "init", "--source", str(source), "--training-permitted"]), 0)
            cases = [
                (["extract", "--name", "expanded-001"], "senmiva_training.archives.extract_dataset", {}, (source, workspace / "datasets" / "expanded-001"), {}),
                (["prepare-multitask", "--cross-split-policy", "exclude-all"], "senmiva_training.multitask_data.prepare_multitask", {"summary": {}}, (workspace / "datasets" / "expanded-001", workspace / "manifests" / "skin-all-001"), {"cross_split_policy": "exclude-all"}),
                (["train-multitask", "--run", "skin-001", "--device", "cpu"], "senmiva_training.multitask_training.train_multitask", {}, (workspace / "manifests" / "skin-all-001", workspace / "runs" / "skin-001"), {"epochs": 5, "batch_size": 8, "learning_rate": 1e-3, "seed": 42, "device": "cpu", "unfreeze": False}),
                (["evaluate-multitask", "--run", "skin-001", "--checkpoint", "last"], "senmiva_training.multitask_training.evaluate_multitask", {}, (workspace / "manifests" / "skin-all-001", workspace / "runs" / "skin-001"), {"checkpoint": "last", "device": "auto", "batch_size": 8}),
                (["prepare-recommendation"], "senmiva_training.recommendation.prepare_recommendation", {}, (workspace / "datasets" / "expanded-001", workspace / "manifests" / "ingredients-001"), {"min_support": 10}),
                (["prepare-code-support"], "senmiva_training.skin_code_contract.build_condition_support", {}, (workspace / "datasets" / "expanded-001", workspace / "manifests" / "ingredients-001", workspace / "contracts" / "ingredients-001-source-codes-v1.json"), {}),
                (["train-recommendation", "--run", "ingredients-linear-001"], "senmiva_training.recommendation.train_recommendation", {}, (workspace / "manifests" / "ingredients-001", workspace / "runs" / "ingredients-linear-001"), {"epochs": 20, "batch_size": 64, "learning_rate": 0.01, "seed": 42, "device": "cpu"}),
                (["evaluate-recommendation", "--run", "ingredients-linear-001"], "senmiva_training.recommendation.evaluate_recommendation", {}, (workspace / "manifests" / "ingredients-001", workspace / "runs" / "ingredients-linear-001"), {"checkpoint": "best", "device": "cpu", "batch_size": 64}),
            ]
            for arguments, target, result, expected_args, expected_kwargs in cases:
                with self.subTest(command=arguments[0]), patch(target, return_value=result) as operation, patch("senmiva_training.trainer.train_model") as old_train, contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(main(["--workspace", str(workspace), *arguments]), 0)
                    operation.assert_called_once_with(*expected_args, **expected_kwargs)
                    old_train.assert_not_called()

    def test_expanded_commands_require_dataset_registration(self):
        with tempfile.TemporaryDirectory() as temp:
            for arguments in (["extract"], ["prepare-multitask"], ["train-multitask", "--run", "skin-001"], ["evaluate-multitask", "--run", "skin-001"], ["prepare-recommendation"], ["prepare-code-support"], ["train-recommendation", "--run", "ingredients-linear-001"], ["evaluate-recommendation", "--run", "ingredients-linear-001"]):
                with self.subTest(command=arguments[0]), contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(main(["--workspace", str(Path(temp) / "private"), *arguments]), 1)
                    self.assertEqual(json.loads(output.getvalue())["code"], "registry_missing")
                    self.assertNotIn(temp, output.getvalue())

    def test_photo_test_is_explicit_and_never_trains(self):
        with tempfile.TemporaryDirectory() as temp:
            source, workspace = Path(temp) / "source", Path(temp) / "private"
            source.mkdir()
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(main(["--workspace", str(workspace), "init", "--source", str(source), "--training-permitted"]), 0)
            with patch("senmiva_training.photo_server.serve_photo_test") as serve, patch("senmiva_training.multitask_training.train_multitask") as train, contextlib.redirect_stdout(io.StringIO()) as output:
                status = main(["--workspace", str(workspace), "photo-test", "--checkpoint", "last", "--port", "8876", "--device", "cpu"])
            self.assertEqual(status, 0)
            serve.assert_called_once_with(workspace / "manifests" / "skin-all-001", workspace / "runs" / "skin-all-head-001", checkpoint="last", device="cpu", port=8876)
            train.assert_not_called()
            self.assertEqual(output.getvalue(), "")

    def test_photo_test_requires_registration_before_loading_or_listening(self):
        with tempfile.TemporaryDirectory() as temp:
            with patch("senmiva_training.photo_server.serve_photo_test") as serve, contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(main(["--workspace", str(Path(temp) / "private"), "photo-test"]), 1)
            serve.assert_not_called()
            self.assertEqual(json.loads(output.getvalue())["code"], "registry_missing")


if __name__ == "__main__":
    unittest.main()
