"""Synthetic read-only ingredient serving; no private data or new training."""

import json
from pathlib import Path
import subprocess
import sys

import pytest

from senmiva_training import ingredient_inference as inference
from senmiva_training import recommendation as training


@pytest.fixture
def experiment(tmp_path, monkeypatch):
    torch = pytest.importorskip("torch")
    manifest, run = tmp_path / "manifest", tmp_path / "run"
    manifest.mkdir()
    run.mkdir()
    rows = {"train": [{"profile_sha256": "a", "targets": [0]}], "validation": [{}]}
    summary = {"manifest_sha256": "synthetic-digest"}
    monkeypatch.setattr(training, "_load_prepared", lambda _: (rows, {"labels": ["Niacinamide", "Panthenol"]}, summary))
    config = {"manifest_sha256": summary["manifest_sha256"], "feature_dimension": 2048, "label_count": 2,
              "model": "structured-profile-linear-multilabel-v1", "target_policy": training._POLICY,
              "threshold": .5, "selection_metric": "validation_micro_f1", "selection_tie_policy": "first",
              "epochs": 1, "batch_size": 8, "learning_rate": .01, "seed": 42}
    validation = {"records": 1, **{key: .5 for key in ("micro_f1", "micro_precision", "micro_recall", "precision_at_5", "recall_at_5", "frequent_baseline_precision_at_5", "frequent_baseline_recall_at_5")}}
    metrics = {"complete": True, "manifest_sha256": summary["manifest_sha256"], "train_records": 1,
               "validation_records": 1, "label_count": 2, "best_epoch": 1, "best_validation": validation,
               "history": [{"epoch": 1, "train_mean_loss": .5, "validation": validation}]}
    state = {"weight": torch.zeros((2, 2048)), "bias": torch.tensor([0., 1.])}
    state["weight"][0, training._feature_indices(("skin_type=건성",))[0]] = 3
    for checkpoint in ("best", "last"):
        torch.save(state, run / f"checkpoint-{checkpoint}.pt")
    for name, content in (("config.json", config), ("metrics.json", metrics)):
        (run / name).write_text(json.dumps(content), encoding="utf-8")
    def seal():
        (run / "artifacts.json").write_text(json.dumps({"complete": True, "sha256": {name: training._sha(run / name) for name in ("config.json", "metrics.json", "checkpoint-best.pt", "checkpoint-last.pt")}}))
    seal()
    return manifest, run, seal, state


def test_import_is_lazy():
    source = str(Path(inference.__file__).resolve().parents[1])
    result = subprocess.run([sys.executable, "-c", f"import sys;sys.path.insert(0,{source!r});import senmiva_training.ingredient_inference;assert 'torch' not in sys.modules"], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_exact_supported_feature_translation_and_missing_fields():
    tokens = inference.kiosk_feature_tokens("dry", ("dehydration", "texture", "uneven_tone", "fine_lines"))
    assert tokens == tuple(sorted(("skin_type=건성", "concern=미백", "concern=주름")))
    assert not any("age" in token or "gender" in token or "condition" in token or "factor" in token for token in tokens)
    assert inference.kiosk_feature_tokens("normal", ("texture",)) == ("skin_type=중성",)
    assert inference.kiosk_feature_tokens("unsure", ("dehydration",)) == ()


@pytest.mark.parametrize("skin,concerns", [("unknown", ("texture",)), ("dry", ()), ("dry", ("texture", "texture")), ("dry", ("private-input",))])
def test_rejects_invalid_features(skin, concerns):
    with pytest.raises(ValueError, match="Invalid kiosk"):
        inference.kiosk_feature_tokens(skin, concerns)


@pytest.mark.parametrize("checkpoint", ["best", "last"])
def test_serves_all_candidates_changes_with_supported_feature_and_writes_nothing(experiment, monkeypatch, checkpoint):
    manifest, run, _, _ = experiment
    torch = pytest.importorskip("torch")
    original = torch.load
    loads = []
    def load(path, **kwargs):
        loads.append(kwargs)
        return original(path, **kwargs)
    monkeypatch.setattr(torch, "load", load)
    before = {path: path.read_bytes() for path in run.parent.rglob("*") if path.is_file()}
    model = inference.IngredientPredictor(manifest, run, checkpoint)
    dry = model.predict_kiosk("dry", ("texture",))
    baseline = model.predict_kiosk("unsure", ("texture",))
    assert loads == [{"weights_only": True, "map_location": "cpu"}]
    assert [item["ingredient"] for item in dry["candidates"]] == ["Niacinamide", "Panthenol"]
    assert [item["ingredient"] for item in baseline["candidates"]] == ["Panthenol", "Niacinamide"]
    assert len(dry["candidates"]) == 2
    assert "no_supported_features_bias_only_baseline" in baseline["input_coverage"]
    assert "visual_codes_not_used_for_ingredients" in dry["input_coverage"]
    assert not model._model.training and all(not value.requires_grad for value in model._model.parameters())
    assert before == {path: path.read_bytes() for path in run.parent.rglob("*") if path.is_file()}
    assert str(run) not in json.dumps(dry)


@pytest.mark.parametrize("artifact", ["config.json", "metrics.json", "checkpoint-best.pt", "checkpoint-last.pt"])
def test_changed_artifact_fails_closed(experiment, artifact):
    manifest, run, _, _ = experiment
    with (run / artifact).open("ab") as stream:
        stream.write(b"tampered")
    with pytest.raises(ValueError, match="could not be verified"):
        inference.IngredientPredictor(manifest, run)


@pytest.mark.parametrize("kind", ["shape", "nan", "complex", "extra"])
def test_even_resealed_invalid_tensor_contract_fails_closed(experiment, kind):
    manifest, run, seal, state = experiment
    torch = pytest.importorskip("torch")
    if kind == "shape":
        state["weight"] = torch.zeros((2, 1))
    elif kind == "nan":
        state["bias"][0] = float("nan")
    elif kind == "complex":
        state["bias"] = state["bias"].to(torch.complex64)
    else:
        state["private"] = torch.zeros(1)
    torch.save(state, run / "checkpoint-best.pt")
    seal()
    with pytest.raises(ValueError, match="could not be verified"):
        inference.IngredientPredictor(manifest, run)


def test_checkpoint_change_during_load_fails_closed(experiment, monkeypatch):
    manifest, run, _, _ = experiment
    torch = pytest.importorskip("torch")
    original = torch.load
    def load(path, **kwargs):
        result = original(path, **kwargs)
        with path.open("ab") as stream:
            stream.write(b"changed")
        return result
    monkeypatch.setattr(torch, "load", load)
    with pytest.raises(ValueError, match="could not be verified"):
        inference.IngredientPredictor(manifest, run)


def test_nonfinite_runtime_outputs_fail_closed(experiment, monkeypatch):
    manifest, run, _, _ = experiment
    torch = pytest.importorskip("torch")
    model = inference.IngredientPredictor(manifest, run)
    monkeypatch.setattr(model._model, "forward", lambda _: torch.full((1, 2), float("nan")))
    with pytest.raises(RuntimeError, match="inference failed"):
        model.predict_kiosk("dry", ("texture",))


PHOTO_A = {"sensitivity": "NS", "pigmentation": "P0", "wrinkles": "W0", "acne": "NA",
           "pores": "NVP", "sagging": "NSA", "keratin": "ND", "redness": "NR"}
PHOTO_B = {**PHOTO_A, "pigmentation": "P2", "pores": "VP"}


def test_photo_whole_category_changes_candidates_with_exact_original_training_hash(experiment, monkeypatch):
    manifest, run, seal, state = experiment
    torch = pytest.importorskip("torch")
    first, second = (inference.visual_condition_token(value) for value in (PHOTO_A, PHOTO_B))
    assert first == training._category("NS/P0/W0/NA/NVP/NSA/ND/NR", "initial_skin_condition")
    monkeypatch.setattr(inference, "load_condition_support", lambda *_: frozenset((first, second)))
    state["weight"][0, training._feature_indices((first,))[0]] = 3
    state["weight"][1, training._feature_indices((second,))[0]] = 3
    for checkpoint in ("best", "last"):
        torch.save(state, run / f"checkpoint-{checkpoint}.pt")
    seal()
    before = {path: path.read_bytes() for path in run.parent.rglob("*") if path.is_file()}
    model = inference.IngredientPredictor(manifest, run, condition_support=run.parent / "support.json")
    a = model.predict_kiosk("unsure", ("texture",), visual_codes=PHOTO_A)
    b = model.predict_kiosk("unsure", ("texture",), visual_codes=PHOTO_B)
    assert a["candidates"][0]["ingredient"] == "Niacinamide"
    assert b["candidates"][0]["ingredient"] == "Panthenol"
    assert a == model.predict_kiosk("unsure", ("texture",), visual_codes=dict(reversed(tuple(PHOTO_A.items()))))
    assert "visual_condition_used_source_contract_v1" in a["input_coverage"]
    assert "source_code_meanings_unverified" in a["input_coverage"]
    assert "combined_pipeline_not_validated" in a["input_coverage"]
    assert "no_supported_features_bias_only_baseline" not in a["input_coverage"]
    assert "visual_codes_not_used_for_ingredients" not in a["input_coverage"]
    assert a["model_version"] == b["model_version"]
    assert len(a["input_coverage"]) <= 16 and max(map(len, a["input_coverage"])) <= 120
    assert before == {path: path.read_bytes() for path in run.parent.rglob("*") if path.is_file()}


def test_unseen_combination_and_missing_photo_retain_questionnaire_scores(experiment, monkeypatch):
    manifest, run, _, _ = experiment
    monkeypatch.setattr(inference, "load_condition_support", lambda *_: frozenset((inference.visual_condition_token(PHOTO_A),)))
    model = inference.IngredientPredictor(manifest, run, condition_support=run.parent / "support.json")
    baseline = model.predict_kiosk("dry", ("texture",))
    unseen = model.predict_kiosk("dry", ("texture",), visual_codes=PHOTO_B)
    assert unseen["candidates"] == baseline["candidates"]
    assert "visual_condition_unseen_in_training_omitted" in unseen["input_coverage"]
    assert "visual_condition_used_source_contract_v1" not in unseen["input_coverage"]
    assert "no_photo_questionnaire_only" in baseline["input_coverage"]
    assert "visual_codes_not_used_for_ingredients" in baseline["input_coverage"]


def test_explicit_invalid_support_refuses_loading_instead_of_silently_omitting(experiment, monkeypatch):
    manifest, run, _, _ = experiment
    def reject(*_):
        raise ValueError("private-path")
    monkeypatch.setattr(inference, "load_condition_support", reject)
    with pytest.raises(ValueError, match="could not be verified"):
        inference.IngredientPredictor(manifest, run, condition_support=run.parent / "support.json")
