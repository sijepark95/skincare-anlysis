import json
import os
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from senmiva_training.workspace import default_workspace, private_output, read_registry, register_dataset


class WorkspaceTests(unittest.TestCase):
    def test_resolved_workspace_pointer_survives_appdata_redirection(self):
        with tempfile.TemporaryDirectory() as temp:
            repo = Path(temp) / "repo"
            pointer = repo / ".local" / "ml-workspace.json"
            pointer.parent.mkdir(parents=True)
            physical = Path(temp) / "physical-private-workspace"
            pointer.write_text(json.dumps({"workspace_path": str(physical)}), encoding="utf-8")
            fake_module = repo / "ml" / "src" / "senmiva_training" / "workspace.py"
            with patch("senmiva_training.workspace.__file__", str(fake_module)), patch.dict(os.environ, {"LOCALAPPDATA": str(Path(temp) / "different-appdata"), "SENMIVA_ML_WORKSPACE": ""}):
                self.assertEqual(default_workspace(), physical)

    def test_cloud_sync_and_repository_rejected(self):
        for path in (Path(__file__).resolve().parents[1] / "models", Path("C:/Users/example/OneDrive/models")):
            with self.assertRaises(ValueError):
                private_output(path)

    def test_source_ancestor_and_descendant_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "source"
            source.mkdir()
            for path in (source / "models", source, source.parent):
                with self.assertRaises(ValueError):
                    private_output(path, source)

    def test_permission_registry_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            source, workspace = Path(temp) / "source", Path(temp) / "private"
            source.mkdir()
            with self.assertRaises(ValueError):
                register_dataset(workspace, source, False, False)
            register_dataset(workspace, source, True, True)
            self.assertEqual(read_registry(workspace)["commercial_use_permission"], "user-confirmed")
            with self.assertRaises(ValueError):
                register_dataset(workspace, source, True, True)
            payload = json.loads((workspace / "dataset.json").read_text())
            payload["training_permission"] = "unconfirmed"
            (workspace / "dataset.json").write_text(json.dumps(payload))
            with self.assertRaises(ValueError):
                read_registry(workspace)
