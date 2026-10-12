"""Read-only serving of a completed structured-profile ingredient experiment.

Kiosk input is deliberately partial. Verified source-code categories may enter
only when witnessed in retained training profiles. Missing fields are omitted.
Outputs rank silver-label candidates;
they do not establish efficacy, ingredient concentration or allergy safety.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from collections.abc import Mapping

from . import recommendation as training
from .workspace import private_output
from .skin_code_contract import load_condition_support, visual_condition_token


SKIN_TYPES = {"normal": "중성", "dry": "건성", "oily": "지성", "combination": "복합성"}
GOALS = {"uneven_tone": "미백", "fine_lines": "주름"}
CONCERNS = {"dehydration", "texture", *GOALS}


def kiosk_feature_tokens(skin_type: str, concern_ids: tuple[str, ...]) -> tuple[str, ...]:
    """Use the original normalizer/hash; omit unsupported source categories."""
    if skin_type not in {*SKIN_TYPES, "unsure"} or not concern_ids or len(concern_ids) > 4 or len(set(concern_ids)) != len(concern_ids) or not set(concern_ids) <= CONCERNS:
        raise ValueError("Invalid kiosk ingredient input.")
    tokens = set()
    if skin_type in SKIN_TYPES:
        tokens.add(training._category(SKIN_TYPES[skin_type], "skin_type"))
    for concern in concern_ids:
        if concern in GOALS:
            tokens.add(training._category(GOALS[concern], "concern"))
    return tuple(sorted(tokens))


def _verified_run(manifest_dir: Path, run_dir: Path, checkpoint: str, condition_support: Path | None) -> dict:
    rows, vocabulary, summary = training._load_prepared(manifest_dir)
    conditions = load_condition_support(condition_support, rows, summary) if condition_support is not None else frozenset()
    if (run_dir / "incomplete.json").exists():
        raise ValueError("Incomplete ingredient experiment.")
    artifacts = json.loads((run_dir / "artifacts.json").read_text(encoding="utf-8"))
    names = {"config.json", "metrics.json", "checkpoint-best.pt", "checkpoint-last.pt"}
    if artifacts.get("complete") is not True or set(artifacts.get("sha256", {})) != names:
        raise ValueError("Invalid ingredient artifact list.")
    for name in names:
        if training._sha(run_dir / name) != artifacts["sha256"][name]:
            raise ValueError("Ingredient artifact changed.")
    config = json.loads((run_dir / "config.json").read_text(encoding="utf-8"))
    if (config.get("manifest_sha256") != summary["manifest_sha256"] or config.get("feature_dimension") != training._DIMENSION
        or config.get("label_count") != len(vocabulary["labels"]) or config.get("model") != "structured-profile-linear-multilabel-v1"
        or config.get("target_policy") != training._POLICY or config.get("threshold") != .5
        or config.get("selection_metric") != "validation_micro_f1" or config.get("selection_tie_policy") != "first"):
        raise ValueError("Ingredient experiment and manifest differ.")
    training._validate_training(config.get("epochs"), config.get("batch_size"), config.get("learning_rate"), config.get("seed"))
    recorded = json.loads((run_dir / "metrics.json").read_text(encoding="utf-8"))
    history = recorded.get("history")
    if (recorded.get("complete") is not True or recorded.get("manifest_sha256") != summary["manifest_sha256"]
        or recorded.get("train_records") != len(rows["train"]) or recorded.get("validation_records") != len(rows["validation"])
        or recorded.get("label_count") != len(vocabulary["labels"]) or not isinstance(history, list) or len(history) != config["epochs"]):
        raise ValueError("Ingredient metrics are invalid.")
    for epoch, item in enumerate(history, 1):
        if (item.get("epoch") != epoch or type(item.get("train_mean_loss")) not in (int, float)
            or not math.isfinite(item["train_mean_loss"]) or item["train_mean_loss"] < 0
            or not isinstance(item.get("validation"), dict) or item["validation"].get("records") != len(rows["validation"])
            or any(type(item["validation"].get(key)) not in (int, float) or not 0 <= item["validation"][key] <= 1
                   for key in ("micro_f1", "micro_precision", "micro_recall", "precision_at_5", "recall_at_5", "frequent_baseline_precision_at_5", "frequent_baseline_recall_at_5"))):
            raise ValueError("Ingredient epoch metrics are invalid.")
    best_index = max(range(len(history)), key=lambda index: history[index]["validation"]["micro_f1"])
    if recorded.get("best_epoch") != best_index + 1 or recorded.get("best_validation") != history[best_index]["validation"]:
        raise ValueError("Ingredient checkpoint selection is invalid.")
    return {"labels": vocabulary["labels"], "conditions": conditions, "checkpoint_sha256": artifacts["sha256"][f"checkpoint-{checkpoint}.pt"],
            "epoch": best_index + 1 if checkpoint == "best" else config["epochs"]}


class IngredientPredictor:
    def __init__(self, manifest_dir: Path, run_dir: Path, checkpoint: str = "best", *, condition_support: Path | None = None) -> None:
        if checkpoint not in ("best", "last"):
            raise ValueError("Ingredient checkpoint must be best or last.")
        try:
            manifest_dir = private_output(Path(manifest_dir))
            run_dir = private_output(Path(run_dir), manifest_dir)
            verified = _verified_run(manifest_dir, run_dir, checkpoint, condition_support)
            import torch
            path = run_dir / f"checkpoint-{checkpoint}.pt"
            state = torch.load(path, weights_only=True, map_location="cpu")
            if training._sha(path) != verified["checkpoint_sha256"]:
                raise ValueError("Ingredient checkpoint changed during loading.")
            if (not isinstance(state, dict) or set(state) != {"weight", "bias"}
                or any(not isinstance(value, torch.Tensor) or not value.is_floating_point() or not torch.isfinite(value).all().item() for value in state.values())
                or tuple(state["weight"].shape) != (len(verified["labels"]), training._DIMENSION)
                or tuple(state["bias"].shape) != (len(verified["labels"]),)):
                raise ValueError("Invalid ingredient tensors.")
            model = torch.nn.Linear(training._DIMENSION, len(verified["labels"]))
            model.load_state_dict(state, strict=True)
            model.requires_grad_(False)
            model.eval()
        except Exception:
            raise ValueError("The completed ingredient experiment could not be verified. Check the offline ML setup.") from None
        self._torch, self._model = torch, model
        self._labels = tuple(verified["labels"])
        self._conditions = verified["conditions"]
        self.model_version = f"{run_dir.name}:{checkpoint}:epoch-{verified['epoch']}"

    def predict_kiosk(self, skin_type: str, concern_ids: tuple[str, ...], *, visual_codes: Mapping[str, str] | None = None) -> dict:
        tokens = kiosk_feature_tokens(skin_type, concern_ids)
        coverage = ["partial_questionnaire_features", "age_gender_external_factors_omitted",
                    "sensitivity_answer_not_used_by_model", "silver_label_uncalibrated_candidate_scores"]
        if visual_codes is None:
            coverage.extend(("initial_skin_condition_omitted", "visual_codes_not_used_for_ingredients", "no_photo_questionnaire_only"))
        else:
            condition = visual_condition_token(visual_codes)
            coverage.extend(("source_code_contract_aihub71886_v1", "source_code_meanings_unverified", "combined_pipeline_not_validated"))
            if condition in self._conditions:
                tokens = tuple(sorted({*tokens, condition}))
                coverage.extend(("visual_condition_used_source_contract_v1", "visual_condition_exact_training_category"))
            else:
                coverage.extend(("initial_skin_condition_omitted", "visual_codes_not_used_for_ingredients",
                                 "visual_condition_unseen_in_training_omitted" if self._conditions else "visual_condition_support_unavailable_omitted"))
        torch = self._torch
        features = torch.zeros((1, training._DIMENSION), dtype=torch.float32)
        features[0, training._feature_indices(tokens)] = 1
        try:
            with torch.inference_mode():
                self._model.eval()
                logits = self._model(features)
                if tuple(logits.shape) != (1, len(self._labels)) or not torch.isfinite(logits).all().item():
                    raise ValueError("Invalid ingredient output.")
                scores = torch.sigmoid(logits)[0].tolist()
            if any(not math.isfinite(score) or not 0 <= score <= 1 for score in scores):
                raise ValueError("Invalid ingredient score.")
        except Exception:
            raise RuntimeError("Ingredient candidate inference failed.") from None
        if skin_type in SKIN_TYPES:
            coverage.append("skin_type_translated_to_source_category")
        if set(concern_ids) & GOALS.keys():
            coverage.append("cosmetic_goals_translated_uneven_tone_to_brightening_fine_lines_to_wrinkles")
        if set(concern_ids) & {"dehydration", "texture"}:
            coverage.append("dehydration_texture_not_mapped_to_source_categories")
        if not tokens:
            coverage.append("no_supported_features_bias_only_baseline")
        return {"model_version": self.model_version,
                "candidates": sorted(({"ingredient": label, "score": score} for label, score in zip(self._labels, scores)),
                                     key=lambda item: (-item["score"], item["ingredient"])),
                "input_coverage": coverage}
