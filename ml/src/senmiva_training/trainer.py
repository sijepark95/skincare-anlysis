"""Explicit offline experiments; importing this module does not import PyTorch.

The two CSV codes are categorical research targets. They are not clinical
grades, pore measurements, or an enabled Senmiva analysis capability.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
import random
import time
import warnings
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CLASSES = ("NVP", "VP")
WARNINGS = (
    "Experimental CSV pore-code classification; visual code meanings and rater provenance are unverified.",
    "Person grouping is unverified; publisher validation is not an independent leakage-free test.",
    "Not a clinical diagnosis, physical skin measurement, or production model.",
)


def confusion_metrics(y_true: list[int], y_pred: list[int]) -> dict[str, Any]:
    """Binary metrics with rows=true and columns=predicted in NVP, VP order.

    Macro F1 always includes both target classes (undefined F1 becomes zero).
    Balanced accuracy averages recall over classes present in y_true; missing
    recall/precision is null rather than a fabricated perfect score. Empty
    input has no accuracy, balanced accuracy, or macro F1.
    """
    if len(y_true) != len(y_pred):
        raise ValueError("True and predicted labels must have equal lengths.")
    if any(type(label) is not int or label not in (0, 1) for label in (*y_true, *y_pred)):
        raise ValueError("Labels must be integer class indexes 0 or 1.")
    matrix = [[0, 0], [0, 0]]
    for actual, predicted in zip(y_true, y_pred):
        matrix[actual][predicted] += 1
    per_class: dict[str, dict[str, Any]] = {}
    recalls: list[float] = []
    f1s: list[float] = []
    for index, name in enumerate(CLASSES):
        tp = matrix[index][index]
        support = sum(matrix[index])
        predicted_count = sum(row[index] for row in matrix)
        precision = tp / predicted_count if predicted_count else None
        recall = tp / support if support else None
        denominator = support + predicted_count
        f1 = 2 * tp / denominator if denominator else 0.0
        if recall is not None:
            recalls.append(recall)
        f1s.append(f1)
        per_class[name] = {
            "support": support,
            "predicted_count": predicted_count,
            "precision": precision,
            "recall": recall,
            "f1": f1,
        }
    total = len(y_true)
    return {
        "classes": list(CLASSES),
        "confusion_matrix": matrix,
        "confusion_matrix_axes": {"rows": "true", "columns": "predicted"},
        "sample_count": total,
        "accuracy": (matrix[0][0] + matrix[1][1]) / total if total else None,
        "balanced_accuracy": sum(recalls) / len(recalls) if recalls else None,
        "macro_f1": sum(f1s) / len(f1s) if total else None,
        "per_class": per_class,
        "all_true_classes_present": all(per_class[name]["support"] for name in CLASSES),
    }


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _manifest_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def train_model(
    manifest_dir: Path,
    output_dir: Path,
    epochs: int = 1,
    batch_size: int = 8,
    learning_rate: float = 1e-3,
    seed: int = 42,
    workers: int = 0,
    pretrained: bool = True,
    device: str = "auto",
    max_steps: int | None = None,
    unfreeze: bool = False,
) -> dict[str, Any]:
    """Train an explicitly requested, isolated ConvNeXt-Tiny experiment.

    A fresh output directory is required; callers must choose private local
    storage outside the repository/cloud-sync folders. max_steps bounds train
    batches *per epoch*, not validation. Use a bounded prepared manifest for a
    smoke run. No model is promoted to serving and no sample predictions,
    questionnaire answers, source paths, or identifiers are saved in outputs.
    """
    from .data import load_image_bytes, load_manifest
    from .workspace import private_output

    if type(epochs) is not int or not 1 <= epochs <= 100:
        raise ValueError("Epochs must be between 1 and 100.")
    if type(batch_size) is not int or not 1 <= batch_size <= 128:
        raise ValueError("Batch size must be between 1 and 128.")
    if not math.isfinite(learning_rate) or not 0 < learning_rate <= 0.1:
        raise ValueError("Learning rate must be finite and between 0 and 0.1.")
    if type(seed) is not int or not 0 <= seed < 2**32:
        raise ValueError("Seed must be an integer between 0 and 2^32 - 1.")
    if workers != 0:
        raise ValueError("This first offline trainer supports workers=0 only (Windows-safe image loading).")
    if max_steps is not None and (type(max_steps) is not int or not 1 <= max_steps <= 100_000):
        raise ValueError("Max steps must be between 1 and 100,000, or omitted.")
    if device not in ("auto", "cpu", "cuda"):
        raise ValueError("Device must be auto, cpu, or cuda.")
    if not pretrained and not unfreeze:
        raise ValueError("Random initialization requires unfreeze=True; a frozen random backbone is not a baseline.")

    manifest_dir = Path(manifest_dir).resolve()
    output_dir = private_output(Path(output_dir), manifest_dir)
    manifest_paths = {name: manifest_dir / f"{name}.jsonl" for name in ("train", "validation")}
    rows_by_split = {name: load_manifest(path) for name, path in manifest_paths.items()}
    if not all(rows_by_split.values()):
        raise ValueError("Both train and validation manifests must contain samples.")
    seen_samples: set[str] = set()
    for split, rows in rows_by_split.items():
        for row in rows:
            if row.get("label") not in CLASSES or row.get("split") != split:
                raise ValueError("Manifest has an unsupported label or incorrect split.")
            sample_id = row.get("sample_id")
            if not isinstance(sample_id, str) or not sample_id or sample_id in seen_samples:
                raise ValueError("Manifest sample identities must be unique within and across splits.")
            seen_samples.add(sample_id)
    train_counts = Counter(row["label"] for row in rows_by_split["train"])
    if any(train_counts[name] == 0 for name in CLASSES):
        raise ValueError("Training must include both NVP and VP labels.")
    validation_counts = Counter(row["label"] for row in rows_by_split["validation"])
    if any(validation_counts[name] == 0 for name in CLASSES):
        raise ValueError("Validation must include both NVP and VP labels before checkpoint selection.")
    # Preparation verifies these digests; recheck the private manifests rather
    # than allowing a manually changed split to bypass exact-duplicate gating.
    image_hashes: dict[str, set[str]] = {}
    for split, rows in rows_by_split.items():
        hashes = [row.get("image_sha256") for row in rows]
        if any(not isinstance(value, str) or len(value) != 64 or any(character not in "0123456789abcdef" for character in value) for value in hashes):
            raise ValueError("Every manifest sample must have a valid audited image SHA-256 digest.")
        image_hashes[split] = set(hashes)
    if image_hashes["train"] & image_hashes["validation"]:
        raise ValueError("An exact image duplicate crosses the train/validation split; resolve it before training.")
    if output_dir.exists():
        raise ValueError("Choose a new output directory; existing experiments are never overwritten.")

    # CUBLAS must see this before CUDA is initialized by this training process.
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    try:
        import torch
        import torchvision
        from PIL import Image, ImageOps, __version__ as pillow_version
        from torch import nn
        from torch.utils.data import DataLoader, Dataset
        from torchvision import transforms
        from torchvision.models import ConvNeXt_Tiny_Weights, convnext_tiny
    except ImportError:
        raise RuntimeError("Install the separate offline ML environment before training.") from None

    selected_device = "cuda" if device == "auto" and torch.cuda.is_available() else device
    if selected_device == "auto":
        selected_device = "cpu"
    if selected_device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable. Check the offline PyTorch CUDA installation, or select cpu.")
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(True)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    generator = torch.Generator().manual_seed(seed)

    weights = ConvNeXt_Tiny_Weights.IMAGENET1K_V1
    evaluation_transform = weights.transforms()
    # Keep complete central skin context. No random crop, strong color shift,
    # geometric distortion, or augmentation of the validation split.
    training_transform = transforms.Compose(
        [
            transforms.Resize(236, interpolation=transforms.InterpolationMode.BILINEAR),
            transforms.CenterCrop(224),
            transforms.RandomHorizontalFlip(p=0.5),
            transforms.ToTensor(),
            transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        ]
    )

    class ImageDataset(Dataset):
        def __init__(self, rows: list[dict[str, Any]], transform: Any) -> None:
            self.rows = rows
            self.transform = transform

        def __len__(self) -> int:
            return len(self.rows)

        def __getitem__(self, index: int) -> tuple[Any, int]:
            row = self.rows[index]
            try:
                raw = load_image_bytes(row)
                with warnings.catch_warnings():
                    warnings.simplefilter("error", Image.DecompressionBombWarning)
                    with Image.open(io.BytesIO(raw)) as image:
                        if image.width * image.height > 25_000_000:
                            raise ValueError("Image exceeds the offline decoded-pixel limit.")
                        image = ImageOps.exif_transpose(image).convert("RGB")
                        transformed = self.transform(image)
            except Exception:
                # Do not expose private paths, archive members or source IDs.
                raise RuntimeError("An image could not be decoded. Run the private manifest audit before training.") from None
            return transformed, CLASSES.index(row["label"])

    use_amp = selected_device == "cuda"
    amp_dtype = torch.bfloat16 if use_amp and torch.cuda.is_bf16_supported() else torch.float16
    config: dict[str, Any] = {
        "schema_version": 1,
        "task": "experimental_csv_pore_code_classification",
        "architecture": "torchvision.convnext_tiny",
        "classes": list(CLASSES),
        "started_at_utc": datetime.now(timezone.utc).isoformat(),
        "epochs": epochs,
        "batch_size": batch_size,
        "learning_rate": learning_rate,
        "backbone_learning_rate": learning_rate * 0.1 if unfreeze else None,
        "optimizer": "AdamW",
        "weight_decay": 0.01,
        "loss": "CrossEntropyLoss; train-only class weight n/(2*class_count); weighted-sum/observed-weight-sum",
        "seed": seed,
        "workers": workers,
        "max_train_steps_per_epoch": max_steps,
        "backbone_frozen": not unfreeze,
        "pretrained_weights": weights.name if pretrained else None,
        "pretrained_weights_url": weights.url if pretrained else None,
        "pretrained_weights_sha256_prefix": "983f1562" if pretrained else None,
        "pretrained_weight_terms": "Review upstream ImageNet weight terms before distributing derivatives.",
        "device": selected_device,
        "gpu_name": torch.cuda.get_device_name(0) if use_amp else None,
        "mixed_precision": str(amp_dtype).removeprefix("torch.") if use_amp else None,
        "deterministic_algorithms": True,
        "versions": {"torch": str(torch.__version__), "torchvision": str(torchvision.__version__), "pillow": pillow_version, "cuda_runtime": torch.version.cuda},
        "manifest_sha256": {name: _manifest_digest(path) for name, path in manifest_paths.items()},
        "manifest_counts": {name: len(rows) for name, rows in rows_by_split.items()},
        "train_label_counts": {name: train_counts[name] for name in CLASSES},
        "grouping_verified": all(row.get("grouping_verified") is True for rows in rows_by_split.values() for row in rows),
        "preprocessing": {
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
        },
        "warnings": list(WARNINGS),
        "selection": "Highest validation balanced accuracy; ties retain the earlier epoch. No independent test is evaluated.",
    }
    output_dir.mkdir(parents=True, exist_ok=False)
    _write_json(output_dir / "run-config.json", config)
    started = time.perf_counter()
    try:
        model = convnext_tiny(weights=weights if pretrained else None, progress=False)
        # Retain pretrained normalization and flattening; replace only Linear.
        input_features = model.classifier[-1].in_features
        if not unfreeze:
            model.requires_grad_(False)
        model.classifier[-1] = nn.Linear(input_features, len(CLASSES))
        model.to(selected_device)
        if unfreeze:
            head_parameters = list(model.classifier[-1].parameters())
            head_ids = {id(parameter) for parameter in head_parameters}
            optimizer_parameters = [
                {"params": [parameter for parameter in model.parameters() if id(parameter) not in head_ids], "lr": learning_rate * 0.1},
                {"params": head_parameters, "lr": learning_rate},
            ]
        else:
            optimizer_parameters = [parameter for parameter in model.parameters() if parameter.requires_grad]
        optimizer = torch.optim.AdamW(optimizer_parameters, lr=learning_rate, weight_decay=0.01)
        class_weights = [len(rows_by_split["train"]) / (len(CLASSES) * train_counts[name]) for name in CLASSES]
        class_weight_tensor = torch.tensor(class_weights, dtype=torch.float32, device=selected_device)
        loss_function = nn.CrossEntropyLoss(weight=class_weight_tensor, reduction="sum")
        scaler = torch.amp.GradScaler("cuda", enabled=use_amp and amp_dtype == torch.float16)
        loaders = {
            split: DataLoader(
                ImageDataset(rows, training_transform if split == "train" else evaluation_transform),
                batch_size=batch_size,
                shuffle=split == "train",
                num_workers=workers,
                pin_memory=use_amp,
                generator=generator,
            )
            for split, rows in rows_by_split.items()
        }
        majority_class = max(range(len(CLASSES)), key=lambda index: train_counts[CLASSES[index]])
        validation_targets = [CLASSES.index(row["label"]) for row in rows_by_split["validation"]]
        baseline = confusion_metrics(validation_targets, [majority_class] * len(validation_targets))
        baseline["method"] = "Constant class chosen from training labels only"
        baseline["predicted_class"] = CLASSES[majority_class]
        history: list[dict[str, Any]] = []
        best_score = -1.0
        best_epoch = 0
        best_validation: dict[str, Any] = {}

        def checkpoint(filename: str, epoch: int, validation: dict[str, Any]) -> None:
            destination = output_dir / filename
            temporary = destination.with_name(destination.name + ".tmp")
            torch.save(
                {
                    "schema_version": 1,
                    "state_dict": {name: tensor.detach().cpu() for name, tensor in model.state_dict().items()},
                    "epoch": epoch,
                    "architecture": config["architecture"],
                    "classes": list(CLASSES),
                    "preprocessing": config["preprocessing"],
                    "run_config": config,
                    "validation_metrics": validation,
                    "experimental": True,
                    "production_ready": False,
                },
                temporary,
            )
            temporary.replace(destination)

        for epoch in range(1, epochs + 1):
            model.train()
            if not unfreeze:
                # Frozen pretrained features must not introduce stochastic-depth
                # variation; the new linear head remains in training mode.
                model.features.eval()
                model.classifier[0].eval()
            train_loss_sum = 0.0
            train_weight_sum = 0.0
            train_count = 0
            train_steps = 0
            for images, labels in loaders["train"]:
                images = images.to(selected_device, non_blocking=use_amp)
                labels = labels.to(selected_device, non_blocking=use_amp)
                optimizer.zero_grad(set_to_none=True)
                with torch.amp.autocast(selected_device, dtype=amp_dtype, enabled=use_amp):
                    logits = model(images)
                    summed_loss = loss_function(logits, labels)
                    batch_weight = class_weight_tensor[labels].sum()
                    loss = summed_loss / batch_weight
                if not torch.isfinite(loss).item():
                    raise RuntimeError("Training produced a non-finite loss; inspect the experiment before retrying.")
                scaler.scale(loss).backward()
                scaler.step(optimizer)
                scaler.update()
                train_loss_sum += summed_loss.item()
                train_weight_sum += batch_weight.item()
                train_count += labels.size(0)
                train_steps += 1
                if max_steps is not None and train_steps >= max_steps:
                    break
            model.eval()
            predicted: list[int] = []
            actual: list[int] = []
            validation_loss_sum = 0.0
            validation_weight_sum = 0.0
            with torch.inference_mode():
                for images, labels in loaders["validation"]:
                    images = images.to(selected_device, non_blocking=use_amp)
                    labels = labels.to(selected_device, non_blocking=use_amp)
                    with torch.amp.autocast(selected_device, dtype=amp_dtype, enabled=use_amp):
                        logits = model(images)
                        loss = loss_function(logits, labels)
                    if not torch.isfinite(loss).item():
                        raise RuntimeError("Validation produced a non-finite loss; inspect the experiment before retrying.")
                    predicted.extend(logits.argmax(dim=1).cpu().tolist())
                    actual.extend(labels.cpu().tolist())
                    validation_loss_sum += loss.item()
                    validation_weight_sum += class_weight_tensor[labels].sum().item()
            validation = confusion_metrics(actual, predicted)
            validation["weighted_cross_entropy"] = validation_loss_sum / validation_weight_sum
            epoch_result = {
                "epoch": epoch,
                "train_steps": train_steps,
                "train_samples_seen": train_count,
                "train_weighted_cross_entropy": train_loss_sum / train_weight_sum,
                "validation": validation,
            }
            history.append(epoch_result)
            score = validation["balanced_accuracy"]
            if score > best_score:
                best_score = score
                best_epoch = epoch
                best_validation = validation
                checkpoint("checkpoint-best.pt", epoch, validation)
            checkpoint("checkpoint-last.pt", epoch, validation)
            result: dict[str, Any] = {
                "schema_version": 1,
                "status": "completed" if epoch == epochs else "in_progress",
                "experimental": True,
                "production_ready": False,
                "grouping_verified": config["grouping_verified"],
                "best_epoch": best_epoch,
                "best_validation": best_validation,
                "constant_baseline": baseline,
                "history": history,
                "elapsed_seconds": round(time.perf_counter() - started, 3),
                "manifest_sha256": config["manifest_sha256"],
                "warnings": list(WARNINGS),
            }
            _write_json(output_dir / "metrics.json", result)
            print(f"Epoch {epoch}/{epochs}: train batches={train_steps}, validation balanced accuracy={score:.4f}, macro F1={validation['macro_f1']:.4f}", flush=True)
        return result
    except torch.cuda.OutOfMemoryError:
        _write_json(output_dir / "failure.json", {"status": "failed", "reason": "cuda_out_of_memory", "experimental": True})
        raise RuntimeError("GPU memory was exhausted. Close other GPU applications or explicitly rerun in a new output directory with a smaller batch size; no automatic retry was made.") from None
    except Exception:
        _write_json(output_dir / "failure.json", {"status": "failed", "reason": "training_failed", "experimental": True})
        raise
