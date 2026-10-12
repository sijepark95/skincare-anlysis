"""Offline, aggregate-only re-evaluation of a local research checkpoint.

The publisher validation partition was already used for model selection. A new
evaluation report does not make it an independent test or promote a model into
the retail application. Importing this module does not import Torch or Pillow.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import hashlib
import io
import json
import math
import os
from pathlib import Path
from typing import Any
from uuid import uuid4
import warnings

from .data import load_image_bytes, load_manifest
from .trainer import CLASSES, WARNINGS, confusion_metrics
from .workspace import private_output


_ARCHITECTURE = "torchvision.convnext_tiny"
_PREPROCESSING = {
    "exif_transpose": True,
    "color_mode": "RGB",
    "max_decoded_pixels": 25_000_000,
    "resize_short_edge": 236,
    "center_crop": [224, 224],
    "interpolation": "bilinear",
    "antialias": True,
    "mean": [0.485, 0.456, 0.406],
    "std": [0.229, 0.224, 0.225],
    "train_only_horizontal_flip_probability": 0.5,
    "crop_warning": "Central crop is a research preprocessing choice, not a validated face/skin-region detector.",
}
_CHECKPOINT_KEYS = {
    "schema_version", "state_dict", "epoch", "architecture", "classes",
    "preprocessing", "run_config", "validation_metrics", "experimental", "production_ready",
}
_MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024
_COMPARISON_TOLERANCE = 1e-6


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_object(path: Path) -> dict[str, Any]:
    try:
        if path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError("Experiment metadata exceeds its size limit.")
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ValueError("Complete, valid local experiment metadata is required.") from None
    if not isinstance(value, dict):
        raise ValueError("Experiment metadata must be an object.")
    return value


def _exact_json(actual: Any, expected: Any) -> bool:
    """JSON equality that does not mistake True for 1 or 224.0 for 224."""
    try:
        return json.dumps(actual, sort_keys=True, allow_nan=False) == json.dumps(expected, sort_keys=True, allow_nan=False)
    except (TypeError, ValueError):
        return False


def _validate_config(config: dict[str, Any]) -> None:
    if (
        type(config.get("schema_version")) is not int or config["schema_version"] != 1
        or config.get("task") != "experimental_csv_pore_code_classification"
        or config.get("architecture") != _ARCHITECTURE
        or not _exact_json(config.get("classes"), list(CLASSES))
        or not _exact_json(config.get("preprocessing"), _PREPROCESSING)
        or config.get("grouping_verified") is not False
        or config.get("device") not in ("cpu", "cuda")
        or config.get("mixed_precision") not in (None, "bfloat16", "float16")
        or (config.get("device") == "cpu" and config.get("mixed_precision") is not None)
        or (config.get("device") == "cuda" and config.get("mixed_precision") is None)
        or type(config.get("epochs")) is not int or not 1 <= config["epochs"] <= 100
        or type(config.get("seed")) is not int or not 0 <= config["seed"] < 2**32
        or config.get("deterministic_algorithms") is not True
    ):
        raise ValueError("Unsupported or changed architecture, class mapping, preprocessing, or run configuration.")


def _preflight(manifest_dir: Path, run_dir: Path, checkpoint: str) -> dict[str, Any]:
    manifest_paths = {split: manifest_dir / f"{split}.jsonl" for split in ("train", "validation")}
    rows = {split: load_manifest(path) for split, path in manifest_paths.items()}
    summary = _read_object(manifest_dir / "summary.json")
    config = _read_object(run_dir / "run-config.json")
    metrics = _read_object(run_dir / "metrics.json")
    _validate_config(config)
    if (
        type(summary.get("schema_version")) is not int or summary["schema_version"] != 1
        or summary.get("task") != "middle-region-source-pore-code-classification"
        or not _exact_json(summary.get("labels"), list(CLASSES))
        or summary.get("grouping_verified") is not False
        or summary.get("validation_role") != "publisher validation for model selection; no independent test set"
    ):
        raise ValueError("Unsupported or changed preparation summary.")
    fingerprints = {split: _digest(path) for split, path in manifest_paths.items()}
    counts = {split: len(samples) for split, samples in rows.items()}
    label_counts = {split: {label: sum(row["label"] == label for row in samples) for label in CLASSES} for split, samples in rows.items()}
    if (
        not _exact_json(config.get("manifest_sha256"), fingerprints)
        or not _exact_json(config.get("manifest_counts"), counts)
        or not _exact_json(config.get("train_label_counts"), label_counts["train"])
        or not _exact_json(metrics.get("manifest_sha256"), fingerprints)
    ):
        raise ValueError("Supplied manifests do not match this training run.")
    if not isinstance(summary.get("partitions"), dict):
        raise ValueError("Preparation summary partitions are invalid.")
    identities: set[str] = set()
    hashes: dict[str, set[str]] = {}
    for split, samples in rows.items():
        if any(row["split"] != split for row in samples):
            raise ValueError("Manifest partition does not match its declared split.")
        if any(label_counts[split][label] == 0 for label in CLASSES):
            raise ValueError("Both classes must be present in each prepared partition.")
        for row in samples:
            if row["sample_id"] in identities:
                raise ValueError("Manifest sample identities overlap across splits.")
            identities.add(row["sample_id"])
            # A private experiment cannot write inside one of its image sources.
            private_output(run_dir, Path(row["image_path"]))
        hashes[split] = {row["image_sha256"] for row in samples}
        partition = "training" if split == "train" else "validation"
        prepared = summary.get("partitions", {}).get(partition, {})
        if (
            not isinstance(prepared, dict)
            or not _exact_json(prepared.get("selected_records"), counts[split])
            or not _exact_json(prepared.get("selected_label_counts"), label_counts[split])
        ):
            raise ValueError("Preparation summary counts do not match the supplied manifests.")
    if hashes["train"] & hashes["validation"]:
        raise ValueError("An exact image duplicate crosses training and validation.")
    checkpoint_path = run_dir / f"checkpoint-{checkpoint}.pt"
    if (
        checkpoint_path.resolve().parent != run_dir
        or not checkpoint_path.is_file()
        or not 0 < checkpoint_path.stat().st_size <= _MAX_CHECKPOINT_BYTES
    ):
        raise ValueError("The requested local checkpoint is unavailable or exceeds its size limit.")
    return {
        "rows": rows, "config": config, "metrics": metrics,
        "manifest_sha256": fingerprints, "summary_sha256": _digest(manifest_dir / "summary.json"),
        "checkpoint_path": checkpoint_path, "checkpoint_sha256": _digest(checkpoint_path),
    }


def _validate_checkpoint(checkpoint: Any, config: dict[str, Any], metrics: dict[str, Any], selection: str) -> dict[str, Any]:
    if (
        not isinstance(checkpoint, dict) or set(checkpoint) != _CHECKPOINT_KEYS
        or type(checkpoint.get("schema_version")) is not int or checkpoint["schema_version"] != 1
        or checkpoint.get("architecture") != _ARCHITECTURE
        or not _exact_json(checkpoint.get("classes"), list(CLASSES))
        or not _exact_json(checkpoint.get("preprocessing"), _PREPROCESSING)
        or not _exact_json(checkpoint.get("run_config"), config)
        or checkpoint.get("experimental") is not True
        or checkpoint.get("production_ready") is not False
        or type(checkpoint.get("epoch")) is not int or not 1 <= checkpoint["epoch"] <= config["epochs"]
        or not isinstance(checkpoint.get("state_dict"), dict) or not checkpoint["state_dict"]
    ):
        raise ValueError("Unsupported or changed checkpoint metadata.")
    if (
        type(metrics.get("schema_version")) is not int or metrics["schema_version"] != 1
        or metrics.get("experimental") is not True or metrics.get("production_ready") is not False
        or metrics.get("grouping_verified") is not False
        or metrics.get("status") not in ("completed", "in_progress")
        or not isinstance(metrics.get("history"), list) or not metrics["history"]
    ):
        raise ValueError("Training metrics metadata is invalid.")
    history = metrics["history"]
    if any(not isinstance(entry, dict) or type(entry.get("epoch")) is not int or entry["epoch"] != index for index, entry in enumerate(history, 1)):
        raise ValueError("Training metric epoch history is invalid.")
    if len(history) > config["epochs"] or (metrics["status"] == "completed" and len(history) != config["epochs"]):
        raise ValueError("Training metric history does not match the configured epochs.")
    scores = []
    for entry in history:
        validation = entry.get("validation")
        score = validation.get("balanced_accuracy") if isinstance(validation, dict) else None
        if type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError("Training history contains an invalid validation score.")
        scores.append(score)
    best_epoch = max(range(len(scores)), key=scores.__getitem__) + 1
    if (
        not _exact_json(metrics.get("best_epoch"), best_epoch)
        or not _exact_json(metrics.get("best_validation"), history[best_epoch - 1]["validation"])
    ):
        raise ValueError("Recorded best epoch does not follow the training selection rule.")
    epoch = checkpoint["epoch"]
    if epoch > len(history):
        raise ValueError("Checkpoint epoch does not match the recorded training history.")
    recorded = checkpoint["validation_metrics"]
    if (
        not isinstance(recorded, dict)
        or not _exact_json(recorded, history[epoch - 1].get("validation"))
        or (selection == "best" and (not _exact_json(metrics.get("best_epoch"), epoch) or not _exact_json(recorded, metrics.get("best_validation"))))
        or (selection == "last" and epoch != len(history))
    ):
        raise ValueError("Checkpoint metrics do not match the selected training epoch.")
    matrix = recorded.get("confusion_matrix")
    if (
        not isinstance(matrix, list) or len(matrix) != 2
        or any(not isinstance(row, list) or len(row) != 2 for row in matrix)
        or any(type(value) is not int or value < 0 for row in matrix for value in row)
        or sum(sum(row) for row in matrix) != config["manifest_counts"]["validation"]
    ):
        raise ValueError("Recorded checkpoint confusion matrix is invalid.")
    actual, predicted = [], []
    for target, row in enumerate(matrix):
        for prediction, count in enumerate(row):
            actual.extend([target] * count)
            predicted.extend([prediction] * count)
    aggregate = confusion_metrics(actual, predicted)
    if any(not _exact_json(recorded.get(key), value) for key, value in aggregate.items()):
        raise ValueError("Recorded checkpoint metrics are internally inconsistent.")
    loss = recorded.get("weighted_cross_entropy")
    if type(loss) not in (int, float) or not math.isfinite(loss) or loss < 0:
        raise ValueError("Recorded checkpoint loss is invalid.")
    aggregate["weighted_cross_entropy"] = loss
    return aggregate


def _decode_image(row: dict[str, Any], transform: Any, image_api: Any, image_ops: Any) -> Any:
    try:
        raw = load_image_bytes(row)
        with warnings.catch_warnings():
            warnings.simplefilter("error", image_api.DecompressionBombWarning)
            with image_api.open(io.BytesIO(raw)) as image:
                if image.width * image.height > _PREPROCESSING["max_decoded_pixels"]:
                    raise ValueError("Decoded image exceeds its pixel limit.")
                oriented = image_ops.exif_transpose(image).convert("RGB")
                return transform(oriented)
    except Exception:
        raise RuntimeError("A validation image could not be verified or decoded within its limits. Run the private manifest audit.") from None


def _evaluate_validation(torch: Any, checkpoint: dict[str, Any], rows: dict[str, list[dict[str, Any]]], config: dict[str, Any], device: str, batch_size: int) -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        import torchvision
        from PIL import Image, ImageOps, __version__ as pillow_version
        from torch import nn
        from torch.utils.data import DataLoader, Dataset
        from torchvision import transforms
        from torchvision.models import convnext_tiny
    except ImportError:
        raise RuntimeError("Install the separate offline ML environment before evaluating a checkpoint.") from None
    selected_device = "cuda" if device == "auto" and torch.cuda.is_available() else device
    if selected_device == "auto":
        selected_device = "cpu"
    if selected_device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable. Check the offline PyTorch CUDA installation, or select cpu.")
    # Reproduce the recorded CUDA validation precision, even when current GPU
    # capabilities differ; never silently change BF16 to FP16 or vice versa.
    use_amp = selected_device == "cuda" and config["mixed_precision"] is not None
    precision = config["mixed_precision"] if use_amp else None
    if precision == "bfloat16" and not torch.cuda.is_bf16_supported():
        raise RuntimeError("This checkpoint used CUDA bfloat16; the selected GPU does not support it. Select cpu explicitly.")
    amp_dtype = torch.bfloat16 if precision == "bfloat16" else torch.float16
    torch.manual_seed(config["seed"])
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(config["seed"])
    torch.use_deterministic_algorithms(True)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    transform = transforms.Compose([
        transforms.Resize(236, interpolation=transforms.InterpolationMode.BILINEAR, antialias=True),
        transforms.CenterCrop(224),
        transforms.ToTensor(),
        transforms.Normalize(mean=_PREPROCESSING["mean"], std=_PREPROCESSING["std"]),
    ])

    class ValidationDataset(Dataset):
        def __len__(self) -> int:
            return len(rows["validation"])

        def __getitem__(self, index: int) -> tuple[Any, int]:
            row = rows["validation"][index]
            return _decode_image(row, transform, Image, ImageOps), CLASSES.index(row["label"])

    model = convnext_tiny(weights=None, progress=False)
    model.classifier[-1] = nn.Linear(model.classifier[-1].in_features, len(CLASSES))
    try:
        model.load_state_dict(checkpoint["state_dict"], strict=True)
    except Exception:
        raise ValueError("Checkpoint tensors do not match the supported two-class architecture.") from None
    model.requires_grad_(False)
    model.to(selected_device)
    model.eval()
    train_counts = Counter(row["label"] for row in rows["train"])
    weights = torch.tensor([len(rows["train"]) / (len(CLASSES) * train_counts[label]) for label in CLASSES], dtype=torch.float32, device=selected_device)
    criterion = nn.CrossEntropyLoss(weight=weights, reduction="sum")
    loader = DataLoader(ValidationDataset(), batch_size=batch_size, shuffle=False, num_workers=0, pin_memory=use_amp)
    actual: list[int] = []
    predicted: list[int] = []
    loss_sum, weight_sum = 0.0, 0.0
    with torch.inference_mode():
        for images, labels in loader:
            images = images.to(selected_device, non_blocking=use_amp)
            labels = labels.to(selected_device, non_blocking=use_amp)
            with torch.amp.autocast(selected_device, dtype=amp_dtype, enabled=use_amp):
                logits = model(images)
                loss = criterion(logits, labels)
            if not torch.isfinite(logits).all().item() or not torch.isfinite(loss).item():
                raise RuntimeError("Checkpoint evaluation produced non-finite values.")
            predicted.extend(logits.argmax(dim=1).cpu().tolist())
            actual.extend(labels.cpu().tolist())
            loss_sum += loss.item()
            weight_sum += weights[labels].sum().item()
    validation = confusion_metrics(actual, predicted)
    validation["weighted_cross_entropy"] = loss_sum / weight_sum
    return validation, {
        "device": selected_device, "mixed_precision": precision,
        "versions": {"torch": str(torch.__version__), "torchvision": str(torchvision.__version__), "pillow": pillow_version, "cuda_runtime": torch.version.cuda},
    }


def _comparison(recorded: dict[str, Any], actual: dict[str, Any], same_precision: bool) -> dict[str, Any]:
    keys = ("accuracy", "balanced_accuracy", "macro_f1", "weighted_cross_entropy")
    deltas = {key: actual[key] - recorded[key] for key in keys}
    matches = actual["confusion_matrix"] == recorded["confusion_matrix"]
    return {
        "absolute_tolerance": _COMPARISON_TOLERANCE,
        "confusion_matrix_matches": matches,
        "same_device_and_precision_as_training": same_precision,
        "deltas": deltas,
        "within_tolerance": matches and all(abs(value) <= _COMPARISON_TOLERANCE for value in deltas.values()),
        "interpretation": "Re-evaluation of the same model-selection validation partition; numerical differences can arise from device, precision, batch size, or library versions. This is not independent validation.",
    }


def evaluate_model(manifest_dir: Path, run_dir: Path, checkpoint: str = "best", device: str = "auto", batch_size: int = 8) -> dict[str, Any]:
    """Load an existing best/last checkpoint and save a new private report.

    No training, downloads, individual predictions, images or source paths are
    saved. The returned report directory is relative to the selected run.
    """
    if checkpoint not in ("best", "last"):
        raise ValueError("Checkpoint must be best or last.")
    if device not in ("auto", "cpu", "cuda"):
        raise ValueError("Device must be auto, cpu, or cuda.")
    if type(batch_size) is not int or not 1 <= batch_size <= 128:
        raise ValueError("Batch size must be between 1 and 128.")
    manifest_dir = private_output(Path(manifest_dir))
    run_dir = private_output(Path(run_dir), manifest_dir)
    inputs = _preflight(manifest_dir, run_dir, checkpoint)
    # This environment setting must precede any CUDA initialization.
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    try:
        import torch
    except ImportError:
        raise RuntimeError("Install the separate offline ML environment before evaluating a checkpoint.") from None
    try:
        saved = torch.load(inputs["checkpoint_path"], weights_only=True, map_location="cpu")
    except Exception:
        raise ValueError("The local checkpoint could not be safely loaded as tensor-only metadata.") from None
    if _digest(inputs["checkpoint_path"]) != inputs["checkpoint_sha256"]:
        raise ValueError("Checkpoint changed while it was being loaded.")
    config = inputs["config"]
    recorded = _validate_checkpoint(saved, config, inputs["metrics"], checkpoint)
    validation_counts = Counter(row["label"] for row in inputs["rows"]["validation"])
    if any(recorded["per_class"][label]["support"] != validation_counts[label] for label in CLASSES):
        raise ValueError("Recorded class supports do not match the validation manifest.")
    validation, runtime = _evaluate_validation(torch, saved, inputs["rows"], config, device, batch_size)
    train_counts = Counter(row["label"] for row in inputs["rows"]["train"])
    majority_index = max(range(len(CLASSES)), key=lambda index: train_counts[CLASSES[index]])
    targets = [CLASSES.index(row["label"]) for row in inputs["rows"]["validation"]]
    baseline = confusion_metrics(targets, [majority_index] * len(targets))
    baseline.update({"method": "Constant class chosen from training labels only", "predicted_class": CLASSES[majority_index]})
    report_name = uuid4().hex
    report_dir = private_output(run_dir / "evaluations" / report_name, manifest_dir)
    if not report_dir.is_relative_to(run_dir):
        raise ValueError("Evaluation reports must remain inside the selected private experiment.")
    result = {
        "schema_version": 1, "status": "completed", "experimental": True, "production_ready": False,
        "evaluation_split": "validation", "independent_test": False, "grouping_verified": False,
        "evaluated_at_utc": datetime.now(timezone.utc).isoformat(),
        "checkpoint": checkpoint, "checkpoint_epoch": saved["epoch"],
        "checkpoint_sha256": inputs["checkpoint_sha256"], "manifest_sha256": inputs["manifest_sha256"],
        "preparation_summary_sha256": inputs["summary_sha256"],
        "architecture": _ARCHITECTURE, "classes": list(CLASSES), "batch_size": batch_size,
        "device": runtime["device"], "mixed_precision": runtime["mixed_precision"], "versions": runtime["versions"],
        "validation": validation, "constant_baseline": baseline,
        "recorded_checkpoint_validation": recorded,
        "recorded_checkpoint_comparison": _comparison(recorded, validation, runtime["device"] == config["device"] and runtime["mixed_precision"] == config["mixed_precision"]),
        "warnings": list(WARNINGS), "report_directory": f"evaluations/{report_name}",
    }
    # Create only after a successful inference pass. Existing training metrics
    # and checkpoint files are never opened for writing.
    report_dir.mkdir(parents=True, exist_ok=False)
    report_dir.chmod(0o700)
    report = report_dir / "summary.json"
    with report.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(result, stream, indent=2, ensure_ascii=False, allow_nan=False)
        stream.write("\n")
    report.chmod(0o600)
    return result
