"""Private workspace policy; no application runtime or Torch dependencies."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path


def default_workspace() -> Path:
    if os.environ.get("SENMIVA_ML_WORKSPACE"):
        return Path(os.environ["SENMIVA_ML_WORKSPACE"])
    pointer = Path(__file__).resolve().parents[3] / ".local" / "ml-workspace.json"
    if pointer.is_file():
        return Path(json.loads(pointer.read_text(encoding="utf-8"))["workspace_path"])
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        raise ValueError("Set --workspace to a private local folder outside cloud sync.")
    return Path(base) / "Senmiva" / "ml"


def private_output(path: Path, source: Path | None = None) -> Path:
    path = path.expanduser().resolve()
    repository = Path(__file__).resolve().parents[3]
    protected = [repository]
    if source is not None:
        protected.append(source.resolve())
    for env_name in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
        if os.environ.get(env_name):
            protected.append(Path(os.environ[env_name]).resolve())
    if any("onedrive" in part.casefold() for part in path.parts):
        raise ValueError("Use a private output folder outside OneDrive.")
    if any(path == root or path.is_relative_to(root) or root.is_relative_to(path) for root in protected):
        raise ValueError("Output must be separate from the repository, dataset and cloud sync.")
    return path


def register_dataset(workspace: Path, source: Path, training: bool, commercial: bool) -> dict:
    workspace = private_output(workspace, source)
    if not training:
        raise ValueError("Training permission must be confirmed before image processing.")
    if not source.is_dir():
        raise ValueError("The dataset folder does not exist.")
    registry = workspace / "dataset.json"
    if registry.exists():
        raise ValueError("Dataset registry already exists; review it locally before changing approval or source.")
    workspace.mkdir(parents=True, exist_ok=True)
    payload = {
        "root_path": str(source.resolve()),
        "schema_matches_dataset_id": "71886",
        "training_permission": "user-confirmed",
        "commercial_use_permission": "user-confirmed" if commercial else "unconfirmed",
        "permission_evidence": "User statement; retain the original provider approval separately.",
        "confirmed_at": datetime.now(timezone.utc).isoformat(),
        "person_grouping": "unverified",
        "visual_label_semantics": "unverified",
        "recommendation_annotation_linkage": "unverified",
    }
    registry.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return {"registered": True, "training_permission": payload["training_permission"]}


def read_registry(workspace: Path) -> dict:
    workspace = private_output(workspace)
    registry = workspace / "dataset.json"
    if not registry.is_file():
        raise ValueError("Initialize the private dataset registry first; see ml/README.md.")
    data = json.loads(registry.read_text(encoding="utf-8"))
    if data.get("training_permission") != "user-confirmed":
        raise ValueError("Dataset training permission is not recorded.")
    if not Path(data["root_path"]).is_dir():
        raise ValueError("The registered dataset folder is unavailable.")
    private_output(workspace, Path(data["root_path"]))
    return data
