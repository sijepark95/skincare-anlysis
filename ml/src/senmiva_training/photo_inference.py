"""Explicit personal-photo experiments with in-memory, local-only inference.

Importing this module does not load Torch, Torchvision or Pillow. It never
trains, stores photos, reads dataset pixels, or writes reports/checkpoints.
"""

from __future__ import annotations

import io
import os
from pathlib import Path
from typing import Any
import warnings

from . import multitask_training as training
from .evaluation import _digest
from .workspace import private_output


MODE = "experimental_local_photo"
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_DECODED_PIXELS = 25_000_000
MIN_IMAGE_EDGE = 224
LABELS = {
    "sensitivity": "민감성", "pigmentation": "미백", "wrinkles": "주름",
    "acne": "여드름", "pores": "모공", "sagging": "피부 처짐",
    "keratin": "과각질", "redness": "붉어짐",
}
WARNINGS = (
    "실험용 모델입니다. 원본 분류 코드의 의미와 평가 기준은 아직 확인되지 않았습니다.",
    "확률은 보정되지 않은 softmax 출력입니다. 임상적 신뢰도, 심각도 또는 측정값이 아닙니다.",
    "얼굴 여부, 피부 영역, 조명, 흐림 및 촬영 품질을 자동 검증하지 않습니다.",
    "학습과 동일한 중앙 자르기를 사용합니다. 전체 얼굴·일반 카메라 사진은 학습 이미지와 달라 결과가 부정확할 수 있습니다.",
    "진단이나 검증된 제품 추천에 사용할 수 없습니다. 사진은 추론 메모리에서만 처리하며 학습하거나 저장하지 않습니다.",
)


class PhotoInputError(ValueError):
    """Safe, user-correctable image rejection; never contains photo details."""


class PhotoPredictor:
    """Load one completed checkpoint, then process supplied image bytes only."""

    def __init__(self, manifest_dir: Path, run_dir: Path, checkpoint: str = "best", device: str = "auto") -> None:
        if checkpoint not in ("best", "last"):
            raise ValueError("Checkpoint must be best or last.")
        if device not in ("auto", "cpu", "cuda"):
            raise ValueError("Device must be auto, cpu, or cuda.")
        try:
            manifest_dir = private_output(Path(manifest_dir))
            run_dir = private_output(Path(run_dir), manifest_dir)
            inputs = training._evaluation_preflight(manifest_dir, run_dir, checkpoint)
            if inputs["metrics"]["status"] != "completed":
                raise ValueError("Only a completed training run can be tested on a personal photo.")
        except Exception:
            raise ValueError("The completed local model and its original manifests could not be verified. Check the offline ML setup.") from None

        os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
        try:
            import torch
            from PIL import Image, ImageOps
            from torchvision import transforms
        except ImportError:
            raise RuntimeError("Install the separate offline ML environment before testing a personal photo.") from None

        try:
            saved = torch.load(inputs["checkpoint_path"], weights_only=True, map_location="cpu")
        except Exception:
            raise ValueError("The checkpoint could not be safely loaded as tensor-only metadata.") from None
        try:
            unchanged = _digest(inputs["checkpoint_path"]) == inputs["checkpoint_sha256"]
        except Exception:
            unchanged = False
        if not unchanged:
            raise ValueError("The checkpoint changed during loading.")
        try:
            training._validate_checkpoint(saved, inputs, checkpoint)
            state = saved["state_dict"]
            if any(not isinstance(key, str) or not isinstance(value, torch.Tensor)
                   or value.is_complex() or not torch.isfinite(value).all().item()
                   for key, value in state.items()):
                raise ValueError("Invalid checkpoint tensors.")
            selected, amp_dtype, use_amp, _ = training._runtime(
                torch, device, inputs["config"]["seed"], inputs["config"]["mixed_precision"],
            )
            model = training.create_multitask_model(pretrained=False)
            model.load_state_dict(state, strict=True)
            model.requires_grad_(False)
            model.to(selected)
            model.eval()
        except Exception:
            raise ValueError("The checkpoint metadata, tensors, architecture or selected device could not be verified.") from None

        self._torch, self._Image, self._ImageOps = torch, Image, ImageOps
        self._model, self._device = model, selected
        self._amp_dtype, self._use_amp = amp_dtype, use_amp
        self._run_name, self._checkpoint, self._epoch = run_dir.name, checkpoint, saved["epoch"]
        self._targets = training._schema()
        self._transform = transforms.Compose([
            transforms.Resize(training.PREPROCESSING["resize_short_edge"], interpolation=transforms.InterpolationMode.BILINEAR, antialias=True),
            transforms.CenterCrop(training.PREPROCESSING["center_crop"]),
            transforms.ToTensor(),
            transforms.Normalize(mean=training.PREPROCESSING["mean"], std=training.PREPROCESSING["std"]),
        ])

    def metadata(self) -> dict[str, Any]:
        """Safe model information without paths, source records or image hashes."""
        return {"schema_version": 1, "mode": MODE, "model_run": self._run_name,
                "checkpoint": self._checkpoint, "checkpoint_epoch": self._epoch,
                "device": self._device, "max_image_bytes": MAX_IMAGE_BYTES,
                "min_image_edge": MIN_IMAGE_EDGE, "max_decoded_pixels": MAX_DECODED_PIXELS,
                "targets": [{"key": key, "label": LABELS[key], "codes": list(codes)} for key, codes in self._targets.items()],
                "warnings": list(WARNINGS)}

    def _decode(self, payload: bytes) -> tuple[Any, dict[str, int]]:
        if type(payload) is not bytes or not payload or len(payload) > MAX_IMAGE_BYTES:
            raise PhotoInputError("Choose one nonempty JPEG, PNG or WebP image up to 10 MiB.")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", self._Image.DecompressionBombWarning)
                with self._Image.open(io.BytesIO(payload)) as image:
                    if (image.format not in ("JPEG", "PNG", "WEBP")
                        or getattr(image, "is_animated", False) or getattr(image, "n_frames", 1) != 1
                        or min(image.size) < MIN_IMAGE_EDGE or image.width * image.height > MAX_DECODED_PIXELS):
                        raise ValueError("Unsupported image.")
                    image.verify()
                with self._Image.open(io.BytesIO(payload)) as image:
                    image.load()
                    oriented = self._ImageOps.exif_transpose(image)
                    rgb = oriented.convert("RGB")
                    try:
                        dimensions = {"width": rgb.width, "height": rgb.height}
                        tensor = self._transform(rgb)
                    finally:
                        rgb.close()
                        if oriented is not image:
                            oriented.close()
            return tensor, dimensions
        except Exception:
            raise PhotoInputError("Use a complete static JPEG, PNG or WebP image, at least 224 pixels on each side and at most 25 million pixels.") from None

    def predict_image(self, payload: bytes) -> dict[str, Any]:
        """Return categorical model outputs; no photo or result persistence."""
        tensor, dimensions = self._decode(payload)
        torch = self._torch
        try:
            if tuple(tensor.shape) != (3, 224, 224) or not torch.isfinite(tensor).all().item():
                raise RuntimeError("Invalid preprocessing output.")
            self._model.eval()
            with torch.inference_mode():
                with torch.amp.autocast(self._device, dtype=self._amp_dtype, enabled=self._use_amp):
                    logits = self._model(tensor.unsqueeze(0).to(self._device))
                if not isinstance(logits, dict) or set(logits) != set(self._targets):
                    raise RuntimeError("Invalid model output schema.")
                heads = []
                for key, codes in self._targets.items():
                    scores = logits[key]
                    if (not isinstance(scores, torch.Tensor) or tuple(scores.shape) != (1, len(codes))
                        or not scores.is_floating_point() or not torch.isfinite(scores).all().item()):
                        raise RuntimeError("Invalid model output values.")
                    probabilities_tensor = torch.softmax(scores.float(), dim=1)[0]
                    if not torch.isfinite(probabilities_tensor).all().item():
                        raise RuntimeError("Invalid softmax output values.")
                    probabilities = probabilities_tensor.cpu().tolist()
                    heads.append({"key": key, "label": LABELS[key], "predicted_code": codes[scores.argmax(dim=1).item()],
                                  "probabilities": [{"code": code, "probability": probability} for code, probability in zip(codes, probabilities)]})
            return {"schema_version": 1, "mode": MODE, "heads": heads, "input": dimensions, "warnings": list(WARNINGS)}
        except Exception:
            raise RuntimeError("Local photo inference failed. No result was saved; check the verified offline model and device.") from None
