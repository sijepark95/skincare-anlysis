"""Explicit, aggregate-only multi-target offline experiments.

Importing this module never imports Torch, Torchvision or Pillow. Source codes
remain categorical research labels; this experiment never enables serving.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import io
import math
import os
from pathlib import Path
import random
import time
from typing import Any
from uuid import uuid4
import warnings

from .evaluation import _digest, _exact_json, _read_object
from .trainer import _write_json
from .workspace import private_output


ARCHITECTURE = "torchvision.convnext_tiny.multitask_linear"
WARNINGS = (
    "Experimental source-code classification; code meanings, visual raters and label provenance are unverified.",
    "Person grouping and image/label region compatibility are unverified; byte separation does not remove near duplicates.",
    "Publisher validation is used for model selection and is not an independent test or product accuracy.",
    "Not a clinical diagnosis, physical skin measurement, or production model.",
)
PREPROCESSING = {
    "exif_transpose": True, "color_mode": "RGB", "max_image_bytes": 40 * 1024 * 1024,
    "max_decoded_pixels": 25_000_000, "resize_short_edge": 236,
    "center_crop": [224, 224], "interpolation": "bilinear", "antialias": True,
    "mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225],
    "train_only_horizontal_flip_probability": 0.5,
    "crop_warning": "Central crop is a research choice, not a validated skin-region detector.",
}
TASK = "experimental_csv_visual_multitask_classification"


def _targets() -> dict[str, tuple[str, ...]]:
    from .multitask_data import TARGETS
    return TARGETS


def _schema() -> dict[str, list[str]]:
    return {name: list(classes) for name, classes in _targets().items()}


def categorical_metrics(y_true: list[int], y_pred: list[int], classes: list[str] | tuple[str, ...], total_images: int | None = None) -> dict[str, Any]:
    """Categorical confusion metrics; absent true-class recall is null.

    Balanced accuracy covers observed true classes. Checkpoint selection uses
    only heads with at least two observed true classes, clearly reported here.
    Macro F1 includes every declared class; no-label input has null metrics.
    """
    if not classes or len(set(classes)) != len(classes) or any(not isinstance(c, str) or not c for c in classes):
        raise ValueError("Class names must be unique nonempty strings.")
    if len(y_true) != len(y_pred):
        raise ValueError("True and predicted labels must have equal lengths.")
    count = len(classes)
    if any(type(label) is not int or not 0 <= label < count for label in (*y_true, *y_pred)):
        raise ValueError("Labels must be valid integer class indexes.")
    if total_images is None:
        total_images = len(y_true)
    if type(total_images) is not int or total_images < len(y_true):
        raise ValueError("Total image count must cover all observed labels.")
    matrix = [[0] * count for _ in classes]
    for actual, predicted in zip(y_true, y_pred):
        matrix[actual][predicted] += 1
    per_class = {}
    recalls, f1s = [], []
    for index, name in enumerate(classes):
        tp, support = matrix[index][index], sum(matrix[index])
        predicted_count = sum(row[index] for row in matrix)
        recall = tp / support if support else None
        f1 = 2 * tp / (support + predicted_count) if support + predicted_count else 0.0
        if recall is not None:
            recalls.append(recall)
        f1s.append(f1)
        per_class[name] = {"support": support, "predicted_count": predicted_count,
                           "precision": tp / predicted_count if predicted_count else None,
                           "recall": recall, "f1": f1}
    observed = len(recalls)
    return {
        "classes": list(classes), "confusion_matrix": matrix,
        "confusion_matrix_axes": {"rows": "true", "columns": "predicted"},
        "sample_count": len(y_true), "total_images": total_images,
        "label_coverage": len(y_true) / total_images if total_images else None,
        "observed_true_class_count": observed,
        "class_coverage": observed / count, "all_true_classes_present": observed == count,
        "missing_true_classes": [name for name in classes if per_class[name]["support"] == 0],
        "evaluable_for_selection": observed >= 2,
        "accuracy": sum(matrix[i][i] for i in range(count)) / len(y_true) if y_true else None,
        "balanced_accuracy": sum(recalls) / observed if observed else None,
        "macro_f1": sum(f1s) / count if y_true else None, "per_class": per_class,
    }


def _selection(heads: dict[str, dict[str, Any]], training_counts: dict[str, dict[str, int]] | None) -> dict[str, Any]:
    for name, head in heads.items():
        observed_training = sum(value > 0 for value in training_counts[name].values()) if training_counts is not None else len(head["classes"])
        head["observed_training_class_count"] = observed_training
        head["training_status"] = "learnable" if observed_training >= 2 else "insufficient_training_classes"
        head["evaluable_for_selection"] = observed_training >= 2 and head["all_true_classes_present"]
    complete = [name for name, head in heads.items() if head["evaluable_for_selection"]]
    selected = complete or [name for name, head in heads.items() if head["observed_training_class_count"] >= 2 and head["observed_true_class_count"] >= 2]
    scores = [heads[name]["balanced_accuracy"] for name in selected]
    return {"evaluable_head_count": len(scores), "selection_heads": selected,
            "selection_coverage": "all_declared_validation_classes" if complete else "partial_validation_class_fallback" if selected else "no_evaluable_heads",
            "selection_coverage_reason": None if complete else "No head has both at least two training classes and all declared validation classes; observed-class balanced accuracy is only a fallback.",
            "mean_balanced_accuracy": sum(scores) / len(scores) if scores else None}


def _aggregate(rows: list[dict[str, Any]], predictions: dict[str, list[int | None]], losses: dict[str, float] | None = None, training_counts: dict[str, dict[str, int]] | None = None) -> dict[str, Any]:
    """Consume transient predictions and return only aggregate reports."""
    def partition(indexes: list[int]) -> dict[str, Any]:
        heads = {}
        for name, classes in _targets().items():
            eligible = [i for i in indexes if rows[i]["labels"][name] is not None]
            actual = [classes.index(rows[i]["labels"][name]) for i in eligible]
            predicted = [predictions[name][i] for i in eligible]
            heads[name] = categorical_metrics(actual, predicted, classes, len(indexes))
        return {"image_count": len(indexes), "heads": heads, **_selection(heads, training_counts)}

    result = partition(list(range(len(rows))))
    regions = sorted({row["region"] for row in rows}, key=lambda value: value or "")
    result["by_region"] = {region or "unknown": partition([i for i, row in enumerate(rows) if row["region"] == region]) for region in regions}
    if losses is not None:
        for name, value in losses.items():
            result["heads"][name]["weighted_cross_entropy"] = value
        active = [value for value in losses.values() if value is not None]
        result["mean_weighted_cross_entropy"] = sum(active) / len(active) if active else None
    return result


def _counts(rows: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    return {name: {label: sum(row["labels"][name] == label for row in rows) for label in classes} for name, classes in _targets().items()}


def _weight_values(counts: dict[str, dict[str, int]]) -> dict[str, list[float]]:
    return {name: [sum(counts[name].values()) / (len(classes) * counts[name][label]) if counts[name][label] and sum(value > 0 for value in counts[name].values()) >= 2 else 0.0 for label in classes] for name, classes in _targets().items()}


def _majority_baseline(rows: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    counts = _counts(rows["train"])
    majority = {name: max(range(len(classes)), key=lambda i: counts[name][classes[i]]) for name, classes in _targets().items()}
    result = _aggregate(rows["validation"], {name: [index] * len(rows["validation"]) for name, index in majority.items()}, training_counts=counts)
    result["method"] = "Constant class for each head chosen from training labels only; ties use declared class order"
    result["predicted_classes"] = {name: _targets()[name][index] for name, index in majority.items()}
    return result


def masked_multitask_loss(logits: dict[str, Any], labels: dict[str, Any], class_weights: dict[str, Any]) -> tuple[Any, dict[str, Any], dict[str, Any]]:
    """Normalize each observed head by its actual weight sum, then average.

    -1 means missing or conflicting supervision and contributes no gradient.
    Returned head numerators/denominators permit correct epoch aggregation,
    including batches with different label coverage and class composition.
    """
    import torch
    from torch.nn import functional as F
    active, sums, denominators = [], {}, {}
    for name, scores in logits.items():
        valid = labels[name] >= 0
        targets = labels[name][valid]
        if not targets.numel():
            continue
        weight_sum = class_weights[name][targets].sum()
        if weight_sum.item() <= 0:
            continue
        loss_sum = F.cross_entropy(scores[valid], targets, weight=class_weights[name], reduction="sum")
        active.append(loss_sum / weight_sum)
        sums[name], denominators[name] = loss_sum, weight_sum
    if not active:
        # Preserve a connected zero so an entirely unlabeled batch is safe.
        return sum(value.sum() * 0 for value in logits.values()), sums, denominators
    return torch.stack(active).mean(), sums, denominators


def create_multitask_model(pretrained: bool = False, unfreeze: bool = False) -> Any:
    """Construct the shared feature model; pretrained=False never downloads."""
    from torch import nn
    from torchvision.models import ConvNeXt_Tiny_Weights, convnext_tiny

    class MultiTargetConvNeXt(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.backbone = convnext_tiny(weights=ConvNeXt_Tiny_Weights.IMAGENET1K_V1 if pretrained else None, progress=False)
            features = self.backbone.classifier[-1].in_features
            self.backbone.classifier[-1] = nn.Identity()
            self.backbone.requires_grad_(unfreeze)
            self.heads = nn.ModuleDict({name: nn.Linear(features, len(classes)) for name, classes in _targets().items()})

        def forward(self, images: Any) -> dict[str, Any]:
            features = self.backbone(images)
            return {name: head(features) for name, head in self.heads.items()}

    return MultiTargetConvNeXt()


def _decode_image(row: dict[str, Any], transform: Any, Image: Any, ImageOps: Any) -> Any:
    from .data import load_image_bytes
    try:
        raw = load_image_bytes(row)
        if len(raw) > PREPROCESSING["max_image_bytes"]:
            raise ValueError("Image byte limit exceeded.")
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                if image.width * image.height > PREPROCESSING["max_decoded_pixels"]:
                    raise ValueError("Image pixel limit exceeded.")
                return transform(ImageOps.exif_transpose(image).convert("RGB"))
    except Exception:
        raise RuntimeError("An image could not be verified or decoded within its limits. Run the private manifest audit.") from None


def _loaders(torch: Any, rows: dict[str, list[dict[str, Any]]], batch_size: int, device: str, seed: int, training: bool) -> dict[str, Any]:
    from PIL import Image, ImageOps
    from torch.utils.data import DataLoader, Dataset
    from torchvision import transforms
    def transform(augment: bool) -> Any:
        operations = [transforms.Resize(236, interpolation=transforms.InterpolationMode.BILINEAR, antialias=True), transforms.CenterCrop(224)]
        if augment:
            operations.append(transforms.RandomHorizontalFlip(p=0.5))
        return transforms.Compose([*operations, transforms.ToTensor(), transforms.Normalize(mean=PREPROCESSING["mean"], std=PREPROCESSING["std"])])

    class Images(Dataset):
        def __init__(self, samples: list[dict[str, Any]], augment: bool) -> None:
            self.rows, self.transform = samples, transform(augment)

        def __len__(self) -> int:
            return len(self.rows)

        def __getitem__(self, index: int) -> tuple[Any, dict[str, int]]:
            row = self.rows[index]
            labels = {name: classes.index(row["labels"][name]) if row["labels"][name] is not None else -1 for name, classes in _targets().items()}
            return _decode_image(row, self.transform, Image, ImageOps), labels

    return {split: DataLoader(Images(samples, training and split == "train"), batch_size=batch_size,
                             shuffle=training and split == "train", num_workers=0,
                             pin_memory=device == "cuda", generator=torch.Generator().manual_seed(seed))
            for split, samples in rows.items() if training or split == "validation"}


def _manifest_preflight(manifest_dir: Path, output_dir: Path) -> dict[str, Any]:
    from .multitask_data import load_multitask_manifest
    paths = {split: manifest_dir / f"{split}.jsonl" for split in ("train", "validation")}
    rows = {split: load_multitask_manifest(path) for split, path in paths.items()}
    summary = _read_object(manifest_dir / "summary.json")
    if not _exact_json(summary.get("target_schema"), _schema()):
        raise ValueError("Manifest target schema does not match this experiment.")
    identities, hashes = set(), {}
    for split, samples in rows.items():
        if not samples or any(row["split"] != split for row in samples):
            raise ValueError("Both correctly declared manifest partitions are required.")
        hashes[split] = set()
        for row in samples:
            if row["sample_id"] in identities or row["image_sha256"] in hashes[split]:
                raise ValueError("Manifest samples and image hashes must be unique.")
            identities.add(row["sample_id"])
            hashes[split].add(row["image_sha256"])
            private_output(output_dir, Path(row["image_path"]))
    if hashes["train"] & hashes["validation"]:
        raise ValueError("An exact image duplicate crosses training and validation.")
    counts = _counts(rows["train"])
    probe = _majority_baseline(rows)
    if not probe["evaluable_head_count"]:
        raise ValueError("Validation must contain at least two observed classes for a target before checkpoint selection.")
    return {"rows": rows, "summary": summary,
            "manifest_sha256": {split: _digest(path) for split, path in paths.items()},
            "preparation_summary_sha256": _digest(manifest_dir / "summary.json"),
            "manifest_counts": {split: len(samples) for split, samples in rows.items()},
            "train_label_counts": counts}


def _options(batch_size: int, device: str) -> None:
    if type(batch_size) is not int or not 1 <= batch_size <= 128:
        raise ValueError("Batch size must be between 1 and 128.")
    if device not in ("auto", "cpu", "cuda"):
        raise ValueError("Device must be auto, cpu, or cuda.")


def _runtime(torch: Any, device: str, seed: int, recorded_precision: Any = "auto") -> tuple[str, Any, bool, str | None]:
    selected = "cuda" if device == "auto" and torch.cuda.is_available() else device
    if selected == "auto":
        selected = "cpu"
    if selected == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable; check the offline installation or select cpu.")
    precision = ("bfloat16" if torch.cuda.is_bf16_supported() else "float16") if selected == "cuda" and recorded_precision == "auto" else recorded_precision
    if selected == "cpu":
        precision = None
    if selected == "cuda" and precision == "bfloat16" and not torch.cuda.is_bf16_supported():
        raise RuntimeError("Recorded CUDA bfloat16 is unsupported on this GPU; select cpu explicitly.")
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(True)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    return selected, torch.bfloat16 if precision == "bfloat16" else torch.float16, selected == "cuda" and precision is not None, precision


def _validation(torch: Any, model: Any, loader: Any, rows: list[dict[str, Any]], weights: dict[str, Any], device: str, amp_dtype: Any, use_amp: bool, training_counts: dict[str, dict[str, int]]) -> dict[str, Any]:
    model.eval()
    predictions = {name: [] for name in _targets()}
    numerators, denominators = Counter(), Counter()
    with torch.inference_mode():
        for images, labels in loader:
            images = images.to(device, non_blocking=use_amp)
            labels = {name: value.to(device, non_blocking=use_amp) for name, value in labels.items()}
            with torch.amp.autocast(device, dtype=amp_dtype, enabled=use_amp):
                logits = model(images)
                loss, sums, weight_sums = masked_multitask_loss(logits, labels, weights)
            if not torch.isfinite(loss).item() or any(not torch.isfinite(value).all().item() for value in logits.values()):
                raise RuntimeError("Validation produced non-finite values.")
            for name in _targets():
                predictions[name].extend(logits[name].argmax(dim=1).cpu().tolist())
            for name in sums:
                numerators[name] += sums[name].item()
                denominators[name] += weight_sums[name].item()
    losses = {name: numerators[name] / denominators[name] if denominators[name] else None for name in _targets()}
    result = _aggregate(rows, predictions, losses, training_counts)
    for name in _targets():
        result["heads"][name]["loss_observed_weight_sum"] = denominators[name]
    return result


def train_multitask(manifest_dir: Path, output_dir: Path, epochs: int = 5, batch_size: int = 8, learning_rate: float = 1e-3, seed: int = 42, device: str = "auto", unfreeze: bool = False) -> dict[str, Any]:
    """Train all prepared images with shared frozen ImageNet features by default."""
    _options(batch_size, device)
    if type(epochs) is not int or not 1 <= epochs <= 100:
        raise ValueError("Epochs must be between 1 and 100.")
    if type(learning_rate) not in (int, float) or not math.isfinite(learning_rate) or not 0 < learning_rate <= 0.1:
        raise ValueError("Learning rate must be finite and between 0 and 0.1.")
    if type(seed) is not int or not 0 <= seed < 2**32 or type(unfreeze) is not bool:
        raise ValueError("A valid integer seed and boolean unfreeze option are required.")
    manifest_dir = private_output(Path(manifest_dir))
    output_dir = private_output(Path(output_dir), manifest_dir)
    inputs = _manifest_preflight(manifest_dir, output_dir)
    if output_dir.exists():
        raise ValueError("Choose a fresh output directory; existing experiments are never overwritten.")
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    try:
        import torch
        import torchvision
        from PIL import __version__ as pillow_version
    except ImportError:
        raise RuntimeError("Install the separate offline ML environment before training.") from None
    selected, amp_dtype, use_amp, precision = _runtime(torch, device, seed)
    config = {
        "schema_version": 1, "task": TASK, "architecture": ARCHITECTURE, "target_schema": _schema(),
        "started_at_utc": datetime.now(timezone.utc).isoformat(), "epochs": epochs,
        "batch_size": batch_size, "learning_rate": learning_rate, "seed": seed,
        "backbone_frozen": not unfreeze, "backbone_learning_rate": learning_rate * 0.1 if unfreeze else None,
        "optimizer": "AdamW", "weight_decay": 0.01, "workers": 0,
        "loss": "Train-only per-class n/(K*count); per-head observed weighted-sum/weight-sum, then mean over active heads; missing/conflicting targets ignored",
        "pretrained_weights": "IMAGENET1K_V1", "pretrained_weight_terms": "Review upstream ImageNet weight terms before distributing derivatives.",
        "preprocessing": PREPROCESSING, "device": selected, "mixed_precision": precision,
        "gpu_name": torch.cuda.get_device_name(0) if selected == "cuda" else None,
        "versions": {"torch": str(torch.__version__), "torchvision": str(torchvision.__version__), "pillow": pillow_version, "cuda_runtime": torch.version.cuda},
        "deterministic_algorithms": True, "grouping_verified": False,
        "region_label_compatibility_verified": False, "label_semantics_verified": False,
        "experimental": True, "production_ready": False,
        "manifest_sha256": inputs["manifest_sha256"], "manifest_counts": inputs["manifest_counts"],
        "preparation_summary_sha256": inputs["preparation_summary_sha256"], "train_label_counts": inputs["train_label_counts"],
        "selection": "Mean balanced accuracy across heads with at least two training classes and all declared validation classes; explicit partial-coverage fallback if none; ties keep earlier epoch; no independent test",
        "warnings": list(WARNINGS),
    }
    output_dir.mkdir(parents=True, exist_ok=False)
    _write_json(output_dir / "run-config.json", config)
    started = time.perf_counter()
    try:
        model = create_multitask_model(pretrained=True, unfreeze=unfreeze).to(selected)
        heads = list(model.heads.parameters())
        parameters = [{"params": model.backbone.parameters(), "lr": learning_rate * 0.1}, {"params": heads, "lr": learning_rate}] if unfreeze else heads
        optimizer = torch.optim.AdamW(parameters, lr=learning_rate, weight_decay=0.01)
        weights = {name: torch.tensor(values, dtype=torch.float32, device=selected) for name, values in _weight_values(inputs["train_label_counts"]).items()}
        scaler = torch.amp.GradScaler("cuda", enabled=use_amp and amp_dtype == torch.float16)
        loaders = _loaders(torch, inputs["rows"], batch_size, selected, seed, True)
        history, best_score, best_epoch, best_validation = [], -1.0, 0, {}
        baseline = _majority_baseline(inputs["rows"])

        def save_checkpoint(name: str, epoch: int, validation: dict[str, Any]) -> None:
            destination = output_dir / f"checkpoint-{name}.pt"
            temporary = destination.with_name(destination.name + ".tmp")
            torch.save({"schema_version": 1, "architecture": ARCHITECTURE, "target_schema": _schema(),
                        "preprocessing": PREPROCESSING, "run_config": config, "epoch": epoch,
                        "state_dict": {key: value.detach().cpu() for key, value in model.state_dict().items()},
                        "validation_metrics": validation, "experimental": True, "production_ready": False}, temporary)
            temporary.replace(destination)

        for epoch in range(1, epochs + 1):
            model.train()
            if not unfreeze:
                model.backbone.eval()
            numerators, denominators, steps, images_seen = Counter(), Counter(), 0, 0
            for images, labels in loaders["train"]:
                images = images.to(selected, non_blocking=use_amp)
                labels = {name: value.to(selected, non_blocking=use_amp) for name, value in labels.items()}
                optimizer.zero_grad(set_to_none=True)
                with torch.amp.autocast(selected, dtype=amp_dtype, enabled=use_amp):
                    loss, sums, weight_sums = masked_multitask_loss(model(images), labels, weights)
                if not torch.isfinite(loss).item():
                    raise RuntimeError("Training produced a non-finite loss.")
                if sums:
                    scaler.scale(loss).backward()
                    scaler.unscale_(optimizer)
                    torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], max_norm=1.0, error_if_nonfinite=True)
                    scaler.step(optimizer)
                    scaler.update()
                for name in sums:
                    numerators[name] += sums[name].item()
                    denominators[name] += weight_sums[name].item()
                steps += 1
                images_seen += images.shape[0]
            if images_seen != inputs["manifest_counts"]["train"]:
                raise RuntimeError("Training did not process every prepared image.")
            validation = _validation(torch, model, loaders["validation"], inputs["rows"]["validation"], weights, selected, amp_dtype, use_amp, inputs["train_label_counts"])
            train_losses = {name: numerators[name] / denominators[name] if denominators[name] else None for name in _targets()}
            observed = [value for value in train_losses.values() if value is not None]
            history.append({"epoch": epoch, "train_steps": steps, "train_images": images_seen,
                            "train_per_head_weighted_cross_entropy": train_losses,
                            "train_mean_weighted_cross_entropy": sum(observed) / len(observed), "validation": validation})
            score = validation["mean_balanced_accuracy"]
            if score > best_score:
                best_score, best_epoch, best_validation = score, epoch, validation
                save_checkpoint("best", epoch, validation)
            save_checkpoint("last", epoch, validation)
            result = {"schema_version": 1, "status": "completed" if epoch == epochs else "in_progress",
                      "experimental": True, "production_ready": False, "grouping_verified": False,
                      "region_label_compatibility_verified": False, "label_semantics_verified": False,
                      "manifest_sha256": inputs["manifest_sha256"], "target_schema": _schema(),
                      "best_epoch": best_epoch, "best_validation": best_validation, "constant_baseline": baseline,
                      "history": history, "elapsed_seconds": time.perf_counter() - started, "warnings": list(WARNINGS)}
            _write_json(output_dir / "metrics.json", result)
        return result
    except Exception:
        _write_json(output_dir / "failure.json", {"status": "failed", "experimental": True, "production_ready": False,
                    "message": "Offline multi-target experiment failed; inspect locally. Private paths and sample details are omitted."})
        raise


def _validate_report(report: Any, rows: list[dict[str, Any]], training_counts: dict[str, dict[str, int]]) -> None:
    """Check confusion-derived metrics, regional supports and coverage flags."""
    def partition(value: Any, samples: list[dict[str, Any]]) -> dict[str, list[list[int]]]:
        if not isinstance(value, dict) or not _exact_json(value.get("image_count"), len(samples)) or not isinstance(value.get("heads"), dict) or set(value["heads"]) != set(_targets()):
            raise ValueError("Validation aggregate schema or image coverage is invalid.")
        calculated, matrices = {}, {}
        for name, classes in _targets().items():
            head = value["heads"][name]
            matrix = head.get("confusion_matrix") if isinstance(head, dict) else None
            if (not isinstance(matrix, list) or len(matrix) != len(classes)
                or any(not isinstance(row, list) or len(row) != len(classes) for row in matrix)
                or any(type(number) is not int or number < 0 for row in matrix for number in row)):
                raise ValueError("Validation confusion counts are invalid.")
            actual, predicted = [], []
            for i, row in enumerate(matrix):
                if sum(row) != sum(sample["labels"][name] == classes[i] for sample in samples):
                    raise ValueError("Validation class supports do not match the manifest.")
                for j, count in enumerate(row):
                    actual.extend([i] * count)
                    predicted.extend([j] * count)
            calculated[name] = categorical_metrics(actual, predicted, classes, len(samples))
            matrices[name] = matrix
        coverage = _selection(calculated, training_counts)
        if any(not _exact_json(value.get(key), expected) for key, expected in coverage.items()):
            raise ValueError("Validation selection coverage is inconsistent.")
        for name, derived in calculated.items():
            if any(not _exact_json(value["heads"][name].get(key), expected) for key, expected in derived.items()):
                raise ValueError("Validation categorical metrics or training coverage are inconsistent.")
        return matrices

    matrices = partition(report, rows)
    regions = {region or "unknown": [row for row in rows if row["region"] == region] for region in {row["region"] for row in rows}}
    if not isinstance(report.get("by_region"), dict) or set(report["by_region"]) != set(regions):
        raise ValueError("Validation region coverage is inconsistent.")
    regional = [partition(report["by_region"][region], samples) for region, samples in regions.items()]
    for name, matrix in matrices.items():
        combined = [[sum(group[name][i][j] for group in regional) for j in range(len(matrix))] for i in range(len(matrix))]
        if combined != matrix:
            raise ValueError("Regional confusion counts do not sum to the complete validation report.")
    losses = []
    for name in _targets():
        loss = report["heads"][name].get("weighted_cross_entropy")
        if loss is not None:
            if type(loss) not in (int, float) or not math.isfinite(loss) or loss < 0:
                raise ValueError("Validation weighted loss is invalid.")
            losses.append(loss)
    if not _exact_json(report.get("mean_weighted_cross_entropy"), sum(losses) / len(losses) if losses else None):
        raise ValueError("Validation mean weighted loss is inconsistent.")


def _evaluation_preflight(manifest_dir: Path, run_dir: Path, checkpoint: str) -> dict[str, Any]:
    inputs = _manifest_preflight(manifest_dir, run_dir)
    config, metrics = _read_object(run_dir / "run-config.json"), _read_object(run_dir / "metrics.json")
    if (type(config.get("schema_version")) is not int or config["schema_version"] != 1
        or config.get("task") != TASK or config.get("architecture") != ARCHITECTURE
        or not _exact_json(config.get("target_schema"), _schema()) or not _exact_json(config.get("preprocessing"), PREPROCESSING)
        or any(config.get(flag) is not False for flag in ("grouping_verified", "region_label_compatibility_verified", "label_semantics_verified"))
        or config.get("experimental") is not True or config.get("production_ready") is not False
        or type(config.get("epochs")) is not int or not 1 <= config["epochs"] <= 100
        or type(config.get("seed")) is not int or not 0 <= config["seed"] < 2**32
        or config.get("device") not in ("cpu", "cuda") or config.get("mixed_precision") not in (None, "bfloat16", "float16")
        or (config.get("device") == "cpu" and config.get("mixed_precision") is not None)
        or (config.get("device") == "cuda" and config.get("mixed_precision") is None)
        or config.get("deterministic_algorithms") is not True):
        raise ValueError("Unsupported or changed multi-target run configuration.")
    for key in ("manifest_sha256", "manifest_counts", "train_label_counts", "preparation_summary_sha256"):
        if not _exact_json(config.get(key), inputs[key]):
            raise ValueError("Supplied manifests do not match this multi-target run.")
    if (type(metrics.get("schema_version")) is not int or metrics["schema_version"] != 1
        or metrics.get("experimental") is not True or metrics.get("production_ready") is not False
        or metrics.get("grouping_verified") is not False
        or not _exact_json(metrics.get("target_schema"), _schema())
        or not _exact_json(metrics.get("manifest_sha256"), inputs["manifest_sha256"])
        or metrics.get("status") not in ("completed", "in_progress")):
        raise ValueError("Training metrics do not match the multi-target run.")
    history = metrics.get("history")
    if (not isinstance(history, list) or not history or len(history) > config["epochs"]
        or (metrics["status"] == "completed" and len(history) != config["epochs"])
        or any(not isinstance(entry, dict) or type(entry.get("epoch")) is not int or entry["epoch"] != index for index, entry in enumerate(history, 1))):
        raise ValueError("Training epoch history is inconsistent.")
    scores = []
    for entry in history:
        _validate_report(entry.get("validation"), inputs["rows"]["validation"], inputs["train_label_counts"])
        score = entry.get("validation", {}).get("mean_balanced_accuracy")
        if type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError("Training history has an invalid selection score.")
        scores.append(score)
    best_epoch = max(range(len(scores)), key=scores.__getitem__) + 1
    if metrics.get("best_epoch") != best_epoch or not _exact_json(metrics.get("best_validation"), history[best_epoch - 1]["validation"]):
        raise ValueError("Best checkpoint does not follow the declared selection rule.")
    path = run_dir / f"checkpoint-{checkpoint}.pt"
    if path.resolve().parent != run_dir or not path.is_file() or not 0 < path.stat().st_size <= 512 * 1024 * 1024:
        raise ValueError("Requested local checkpoint is unavailable or exceeds its size limit.")
    return {**inputs, "config": config, "metrics": metrics, "checkpoint_path": path, "checkpoint_sha256": _digest(path)}


def _validate_checkpoint(saved: Any, inputs: dict[str, Any], selection: str) -> dict[str, Any]:
    config, metrics = inputs["config"], inputs["metrics"]
    keys = {"schema_version", "architecture", "target_schema", "preprocessing", "run_config", "epoch", "state_dict", "validation_metrics", "experimental", "production_ready"}
    epoch = saved.get("epoch") if isinstance(saved, dict) else None
    if (not isinstance(saved, dict) or set(saved) != keys or type(saved.get("schema_version")) is not int or saved["schema_version"] != 1
        or saved.get("architecture") != ARCHITECTURE or not _exact_json(saved.get("target_schema"), _schema())
        or not _exact_json(saved.get("preprocessing"), PREPROCESSING) or not _exact_json(saved.get("run_config"), config)
        or saved.get("experimental") is not True or saved.get("production_ready") is not False
        or type(epoch) is not int or not 1 <= epoch <= len(metrics["history"])
        or not isinstance(saved.get("state_dict"), dict) or not saved["state_dict"]):
        raise ValueError("Unsupported or changed multi-target checkpoint metadata.")
    recorded = saved["validation_metrics"]
    if (not _exact_json(recorded, metrics["history"][epoch - 1]["validation"])
        or (selection == "best" and epoch != metrics["best_epoch"])
        or (selection == "last" and epoch != len(metrics["history"]))):
        raise ValueError("Checkpoint does not match the recorded training epoch.")
    _validate_report(recorded, inputs["rows"]["validation"], inputs["train_label_counts"])
    return recorded


def _evaluate_saved(torch: Any, saved: dict[str, Any], inputs: dict[str, Any], device: str, batch_size: int) -> tuple[dict[str, Any], dict[str, Any]]:
    import torchvision
    from PIL import __version__ as pillow_version
    config = inputs["config"]
    selected, amp_dtype, use_amp, precision = _runtime(torch, device, config["seed"], config["mixed_precision"])
    model = create_multitask_model(pretrained=False)
    try:
        model.load_state_dict(saved["state_dict"], strict=True)
    except Exception:
        raise ValueError("Checkpoint tensors do not match the declared multi-target architecture.") from None
    model.requires_grad_(False)
    model.to(selected)
    loaders = _loaders(torch, inputs["rows"], batch_size, selected, config["seed"], False)
    weights = {name: torch.tensor(values, dtype=torch.float32, device=selected) for name, values in _weight_values(inputs["train_label_counts"]).items()}
    validation = _validation(torch, model, loaders["validation"], inputs["rows"]["validation"], weights, selected, amp_dtype, use_amp, inputs["train_label_counts"])
    return validation, {"device": selected, "mixed_precision": precision,
                        "versions": {"torch": str(torch.__version__), "torchvision": str(torchvision.__version__), "pillow": pillow_version, "cuda_runtime": torch.version.cuda}}


def evaluate_multitask(manifest_dir: Path, run_dir: Path, checkpoint: str = "best", device: str = "auto", batch_size: int = 8) -> dict[str, Any]:
    """Reload tensor-only local weights and save a unique aggregate report."""
    _options(batch_size, device)
    if checkpoint not in ("best", "last"):
        raise ValueError("Checkpoint must be best or last.")
    manifest_dir = private_output(Path(manifest_dir))
    run_dir = private_output(Path(run_dir), manifest_dir)
    inputs = _evaluation_preflight(manifest_dir, run_dir, checkpoint)
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    try:
        import torch
    except ImportError:
        raise RuntimeError("Install the separate offline ML environment before evaluating.") from None
    try:
        saved = torch.load(inputs["checkpoint_path"], weights_only=True, map_location="cpu")
    except Exception:
        raise ValueError("Checkpoint could not be safely loaded as tensor-only metadata.") from None
    if _digest(inputs["checkpoint_path"]) != inputs["checkpoint_sha256"]:
        raise ValueError("Checkpoint changed during loading.")
    recorded = _validate_checkpoint(saved, inputs, checkpoint)
    validation, runtime = _evaluate_saved(torch, saved, inputs, device, batch_size)
    matches = all(validation["heads"][name]["confusion_matrix"] == recorded["heads"][name]["confusion_matrix"] for name in _targets())
    deltas = {name: {key: validation["heads"][name][key] - recorded["heads"][name][key]
                     for key in ("accuracy", "balanced_accuracy", "macro_f1", "weighted_cross_entropy")
                     if validation["heads"][name][key] is not None and recorded["heads"][name][key] is not None}
              for name in _targets()}
    report_name = uuid4().hex
    report_dir = private_output(run_dir / "evaluations" / report_name, manifest_dir)
    result = {"schema_version": 1, "status": "completed", "experimental": True, "production_ready": False,
              "evaluation_split": "validation", "independent_test": False, "grouping_verified": False,
              "region_label_compatibility_verified": False, "label_semantics_verified": False,
              "evaluated_at_utc": datetime.now(timezone.utc).isoformat(),
              "checkpoint": checkpoint, "checkpoint_epoch": saved["epoch"], "checkpoint_sha256": inputs["checkpoint_sha256"],
              "manifest_sha256": inputs["manifest_sha256"], "preparation_summary_sha256": inputs["preparation_summary_sha256"],
              "architecture": ARCHITECTURE, "target_schema": _schema(), "batch_size": batch_size, **runtime,
              "validation": validation, "constant_baseline": _majority_baseline(inputs["rows"]),
              "recorded_checkpoint_validation": recorded,
              "recorded_checkpoint_comparison": {"confusion_matrices_match": matches, "absolute_tolerance": 1e-6,
                  "within_tolerance": matches and all(abs(delta) <= 1e-6 for head in deltas.values() for delta in head.values()),
                  "deltas": deltas, "same_device_and_precision_as_training": runtime["device"] == inputs["config"]["device"] and runtime["mixed_precision"] == inputs["config"]["mixed_precision"],
                  "interpretation": "Same model-selection validation partition; numerical differences may arise from device, precision, batch size or library versions. This is not independent validation."},
              "warnings": list(WARNINGS), "report_directory": f"evaluations/{report_name}"}
    report_dir.mkdir(parents=True, exist_ok=False)
    report_dir.chmod(0o700)
    _write_json(report_dir / "summary.json", result)
    (report_dir / "summary.json").chmod(0o600)
    return result
