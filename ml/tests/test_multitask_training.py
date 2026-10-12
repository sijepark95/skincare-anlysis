"""Synthetic multi-target training/evaluation contracts; no private sources."""

from copy import deepcopy
import csv
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
from types import ModuleType

import pytest

from senmiva_training import multitask_training as training
from senmiva_training.multitask_data import REGION_COLUMN, TARGET_COLUMNS, TARGETS, prepare_multitask


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


@pytest.fixture
def prepared(tmp_path: Path) -> dict:
    source = tmp_path / "source"
    for split, count in (("TS_source", 5), ("VS_source", 3)):
        for index in range(count):
            folder = source / split / str(index)
            folder.mkdir(parents=True)
            labels = {name: classes[index % len(classes)] for name, classes in TARGETS.items()}
            if split == "VS_source" and index == 2:
                labels["acne"] = ""
            stream = io.StringIO(newline="")
            writer = csv.writer(stream)
            writer.writerow([REGION_COLUMN, *TARGET_COLUMNS.values()])
            writer.writerow([("상", "중", "하")[index % 3], *labels.values()])
            (folder / "sample.csv").write_text(stream.getvalue(), encoding="utf-8-sig")
            (folder / "sample.jpg").write_bytes(f"synthetic image {split}/{index}".encode())
    manifest = tmp_path / "manifest"
    prepare_multitask(source, manifest)
    return {"source": source, "manifest": manifest, "run": tmp_path / "run"}


@pytest.fixture
def experiment(prepared: dict) -> dict:
    run = prepared["run"]
    run.mkdir()
    inputs = training._manifest_preflight(prepared["manifest"], run)
    config = {"schema_version": 1, "task": training.TASK, "architecture": training.ARCHITECTURE,
              "target_schema": training._schema(), "preprocessing": deepcopy(training.PREPROCESSING),
              "epochs": 2, "seed": 42, "device": "cpu", "mixed_precision": None,
              "grouping_verified": False, "region_label_compatibility_verified": False, "label_semantics_verified": False,
              "experimental": True, "production_ready": False, "deterministic_algorithms": True,
              **{key: inputs[key] for key in ("manifest_sha256", "manifest_counts", "train_label_counts", "preparation_summary_sha256")}}
    val = inputs["rows"]["validation"]
    perfect = {name: [classes.index(row["labels"][name]) if row["labels"][name] is not None else 0 for row in val] for name, classes in TARGETS.items()}
    first = training._aggregate(val, perfect, {name: 0.4 for name in TARGETS}, inputs["train_label_counts"])
    last = training._aggregate(val, {name: [0] * len(val) for name in TARGETS}, {name: 0.7 for name in TARGETS}, inputs["train_label_counts"])
    metrics = {"schema_version": 1, "status": "completed", "experimental": True, "production_ready": False,
               "grouping_verified": False, "target_schema": training._schema(),
               "manifest_sha256": inputs["manifest_sha256"], "best_epoch": 1, "best_validation": first,
               "history": [{"epoch": 1, "validation": first}, {"epoch": 2, "validation": last}]}
    checkpoints = {}
    for selection, epoch, validation in (("best", 1, first), ("last", 2, last)):
        (run / f"checkpoint-{selection}.pt").write_bytes(f"synthetic checkpoint {selection}".encode())
        checkpoints[selection] = {"schema_version": 1, "architecture": training.ARCHITECTURE,
                                  "target_schema": training._schema(), "preprocessing": deepcopy(training.PREPROCESSING),
                                  "run_config": deepcopy(config), "epoch": epoch, "state_dict": {"fake.weight": "fake tensor"},
                                  "validation_metrics": deepcopy(validation), "experimental": True, "production_ready": False}
    write_json(run / "run-config.json", config)
    write_json(run / "metrics.json", metrics)
    return {**prepared, "config": config, "metrics": metrics, "checkpoints": checkpoints, "rows": inputs["rows"]}


@pytest.fixture
def fake_runtime(monkeypatch: pytest.MonkeyPatch, experiment: dict) -> dict:
    calls = {"load": [], "inference": []}
    torch = ModuleType("torch")

    def load(path, **kwargs):
        calls["load"].append((Path(path).name, kwargs))
        return deepcopy(experiment["checkpoints"][Path(path).stem.removeprefix("checkpoint-")])

    def evaluate(torch_api, saved, inputs, device, batch_size):
        calls["inference"].append((saved["epoch"], device, batch_size))
        return deepcopy(saved["validation_metrics"]), {"device": "cpu", "mixed_precision": None, "versions": {"torch": "synthetic"}}

    torch.load = load
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setattr(training, "_evaluate_saved", evaluate)
    return calls


def test_import_is_lazy() -> None:
    source = str(Path(training.__file__).resolve().parents[1])
    code = f"import sys; sys.path.insert(0,{source!r}); import senmiva_training.multitask_training; assert not any(name in sys.modules for name in ('torch','torchvision','PIL'))"
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_three_class_metrics_and_missing_recall() -> None:
    result = training.categorical_metrics([0, 0, 1], [0, 1, 1], ("P0", "P1", "P2"), total_images=5)
    assert result["confusion_matrix"] == [[1, 1, 0], [0, 1, 0], [0, 0, 0]]
    assert result["accuracy"] == pytest.approx(2 / 3)
    assert result["balanced_accuracy"] == 0.75
    assert result["macro_f1"] == pytest.approx(4 / 9)
    assert result["per_class"]["P2"]["recall"] is None
    assert result["per_class"]["P2"]["precision"] is None
    assert result["missing_true_classes"] == ["P2"]
    assert result["label_coverage"] == 0.6
    assert result["class_coverage"] == pytest.approx(2 / 3)
    assert not result["all_true_classes_present"]


def test_empty_and_single_class_metrics_are_clear() -> None:
    result = training.categorical_metrics([], [], ["A", "B"], total_images=4)
    assert result["accuracy"] is None and result["balanced_accuracy"] is None and result["macro_f1"] is None
    assert result["label_coverage"] == 0 and result["missing_true_classes"] == ["A", "B"]
    result = training.categorical_metrics([0], [0], ["A", "B"])
    assert result["balanced_accuracy"] == 1 and not result["evaluable_for_selection"]


@pytest.mark.parametrize("true,pred,classes,total", [
    ([True], [0], ["A", "B"], 1), ([2], [0], ["A", "B"], 1),
    ([0], [], ["A", "B"], 1), ([0], [0], ["A", "A"], 1),
    ([0], [0], ["A", "B"], 0),
])
def test_metrics_reject_invalid_indexes_and_coverage(true, pred, classes, total) -> None:
    with pytest.raises(ValueError):
        training.categorical_metrics(true, pred, classes, total)


def test_selection_uses_complete_heads_and_flags_unsupported_training(monkeypatch: pytest.MonkeyPatch) -> None:
    targets = {"binary": ("N", "Y"), "three": ("A", "B", "C"), "unsupported": ("N", "Y")}
    monkeypatch.setattr(training, "_targets", lambda: targets)
    rows = [{"region": None, "labels": {"binary": "N", "three": "A", "unsupported": "N"}},
            {"region": "중", "labels": {"binary": "Y", "three": "B", "unsupported": "Y"}}]
    counts = {"binary": {"N": 4, "Y": 2}, "three": {"A": 2, "B": 2, "C": 2}, "unsupported": {"N": 4, "Y": 0}}
    result = training._aggregate(rows, {"binary": [0, 1], "three": [0, 1], "unsupported": [0, 0]}, training_counts=counts)
    assert result["selection_heads"] == ["binary"]
    assert result["selection_coverage"] == "all_declared_validation_classes"
    assert result["heads"]["unsupported"]["training_status"] == "insufficient_training_classes"
    assert result["heads"]["three"]["missing_true_classes"] == ["C"]
    assert "unknown" in result["by_region"]
    assert training._weight_values(counts)["unsupported"] == [0.0, 0.0]
    rows[1]["labels"]["binary"] = "N"
    result = training._aggregate(rows, {"binary": [0, 0], "three": [0, 1], "unsupported": [0, 0]}, training_counts=counts)
    assert result["selection_heads"] == ["three"]
    assert result["selection_coverage"] == "partial_validation_class_fallback"
    assert result["selection_coverage_reason"]


def test_masked_loss_uses_observed_weight_per_head_and_ignores_missing_gradients() -> None:
    torch = pytest.importorskip("torch")
    logits = {"a": torch.tensor([[2.0, 0.0], [0.0, 3.0], [2.0, 0.0]], requires_grad=True),
              "b": torch.tensor([[0.0, 2.0], [7.0, 0.0], [9.0, 0.0]], requires_grad=True),
              "missing": torch.zeros(3, 2, requires_grad=True)}
    labels = {"a": torch.tensor([0, 1, 1]), "b": torch.tensor([1, -1, -1]), "missing": torch.tensor([-1, -1, -1])}
    weights = {"a": torch.tensor([0.5, 2.0]), "b": torch.tensor([8.0, 3.0]), "missing": torch.ones(2)}
    loss, numerators, denominators = training.masked_multitask_loss(logits, labels, weights)
    expected_a = torch.nn.functional.cross_entropy(logits["a"], labels["a"], weight=weights["a"], reduction="sum") / 4.5
    expected_b = torch.nn.functional.cross_entropy(logits["b"][:1], labels["b"][:1])
    assert loss.item() == pytest.approx(((expected_a + expected_b) / 2).item())
    assert set(numerators) == {"a", "b"}
    assert denominators["a"].item() == 4.5 and denominators["b"].item() == 3
    loss.backward()
    assert torch.equal(logits["b"].grad[1:], torch.zeros(2, 2))
    assert logits["missing"].grad is None


def test_all_missing_loss_and_zero_training_weights() -> None:
    torch = pytest.importorskip("torch")
    logits = {"a": torch.zeros(2, 2, requires_grad=True)}
    for labels, weights in ((torch.tensor([-1, -1]), torch.ones(2)), (torch.tensor([0, 0]), torch.zeros(2))):
        loss, numerators, denominators = training.masked_multitask_loss(logits, {"a": labels}, {"a": weights})
        assert loss.item() == 0 and not numerators and not denominators
        loss.backward()
        assert torch.equal(logits["a"].grad, torch.zeros(2, 2))


@pytest.mark.parametrize("kwargs", [{"epochs": True}, {"epochs": 0}, {"batch_size": 0}, {"batch_size": True},
                                     {"learning_rate": float("nan")}, {"learning_rate": True}, {"seed": -1},
                                     {"seed": True}, {"unfreeze": 1}, {"device": "mps"}])
def test_bad_training_options_fail_before_preflight(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kwargs: dict) -> None:
    monkeypatch.setattr(training, "_manifest_preflight", lambda *args: pytest.fail("No manifest reads expected"))
    with pytest.raises(ValueError):
        training.train_multitask(tmp_path / "manifest", tmp_path / "run", **kwargs)


@pytest.mark.parametrize("kwargs", [{"checkpoint": "../bad"}, {"batch_size": True}, {"batch_size": 129}, {"device": "mps"}])
def test_bad_evaluation_options_fail_before_preflight(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kwargs: dict) -> None:
    monkeypatch.setattr(training, "_evaluation_preflight", lambda *args: pytest.fail("No manifest reads expected"))
    with pytest.raises(ValueError):
        training.evaluate_multitask(tmp_path / "manifest", tmp_path / "run", **kwargs)


@pytest.mark.parametrize("selection,epoch", [("best", 1), ("last", 2)])
def test_tensor_only_reload_aggregate_reports_and_original_file_hashes(experiment: dict, fake_runtime: dict, selection: str, epoch: int) -> None:
    originals = {path.name: path.read_bytes() for path in experiment["run"].iterdir()}
    first = training.evaluate_multitask(experiment["manifest"], experiment["run"], checkpoint=selection, device="cpu", batch_size=3)
    assert fake_runtime["load"] == [(f"checkpoint-{selection}.pt", {"weights_only": True, "map_location": "cpu"})]
    assert fake_runtime["inference"] == [(epoch, "cpu", 3)]
    assert first["recorded_checkpoint_comparison"]["within_tolerance"]
    assert first["validation"]["image_count"] == 3
    assert first["validation"]["heads"]["acne"]["sample_count"] == 2
    assert first["experimental"] and not first["production_ready"] and not first["independent_test"]
    report = experiment["run"] / first["report_directory"] / "summary.json"
    assert json.loads(report.read_text(encoding="utf-8")) == first
    second = training.evaluate_multitask(experiment["manifest"], experiment["run"], checkpoint=selection)
    assert second["report_directory"] != first["report_directory"]
    for name, value in originals.items():
        assert (experiment["run"] / name).read_bytes() == value
    assert first["checkpoint_sha256"] == hashlib.sha256(originals[f"checkpoint-{selection}.pt"]).hexdigest()
    payload = json.dumps(first)
    for rows in experiment["rows"].values():
        for row in rows:
            assert row["sample_id"] not in payload and row["image_path"] not in payload
    assert "state_dict" not in payload and "run_config" not in payload


def test_changed_manifest_fails_before_torch_load(experiment: dict, fake_runtime: dict) -> None:
    with (experiment["manifest"] / "validation.jsonl").open("a", encoding="utf-8") as stream:
        stream.write("\n")
    with pytest.raises(ValueError):
        training.evaluate_multitask(experiment["manifest"], experiment["run"])
    assert not fake_runtime["load"] and not (experiment["run"] / "evaluations").exists()


@pytest.mark.parametrize("field,value", [("architecture", "other"), ("target_schema", {}),
                                        ("manifest_counts", {"train": 100, "validation": 3}),
                                        ("grouping_verified", True), ("device", "cuda"),
                                        ("preprocessing", {**training.PREPROCESSING, "resize_short_edge": 224})])
def test_changed_run_metadata_fails_before_torch_load(experiment: dict, fake_runtime: dict, field: str, value) -> None:
    config = deepcopy(experiment["config"])
    config[field] = value
    write_json(experiment["run"] / "run-config.json", config)
    with pytest.raises(ValueError):
        training.evaluate_multitask(experiment["manifest"], experiment["run"])
    assert not fake_runtime["load"]


@pytest.mark.parametrize("mutation", ["schema", "epoch", "score", "support", "derived_metric", "production", "region", "head_coverage", "selection_coverage"])
def test_changed_checkpoint_metadata_and_counts_rejected(experiment: dict, fake_runtime: dict, mutation: str) -> None:
    saved = experiment["checkpoints"]["best"]
    if mutation == "schema":
        saved["target_schema"]["pores"].reverse()
    elif mutation == "epoch":
        saved["epoch"] = 2
    elif mutation == "production":
        saved["production_ready"] = True
    else:
        validation = saved["validation_metrics"]
        if mutation == "score":
            validation["mean_balanced_accuracy"] = 0.1
        elif mutation == "support":
            validation["heads"]["pores"]["confusion_matrix"][0][0] += 1
        elif mutation == "derived_metric":
            validation["heads"]["pores"]["accuracy"] = 0.0
        elif mutation == "region":
            validation["by_region"]["중"]["heads"]["pores"]["accuracy"] = 0.0
        elif mutation == "head_coverage":
            validation["heads"]["pores"]["training_status"] = "insufficient_training_classes"
        else:
            validation["selection_coverage"] = "partial_validation_class_fallback"
        # Coordinate the history to test internal consistency, not only equality.
        experiment["metrics"]["history"][0]["validation"] = deepcopy(validation)
        experiment["metrics"]["best_validation"] = deepcopy(validation)
        write_json(experiment["run"] / "metrics.json", experiment["metrics"])
    with pytest.raises(ValueError):
        training.evaluate_multitask(experiment["manifest"], experiment["run"])
    assert not fake_runtime["inference"]
    assert not (experiment["run"] / "evaluations").exists()


def test_hash_change_during_checkpoint_load_rejected(experiment: dict, fake_runtime: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    torch = sys.modules["torch"]
    original = torch.load
    def changed(path, **kwargs):
        saved = original(path, **kwargs)
        Path(path).write_bytes(b"changed")
        return saved
    monkeypatch.setattr(torch, "load", changed)
    with pytest.raises(ValueError, match="changed during"):
        training.evaluate_multitask(experiment["manifest"], experiment["run"])
    assert not fake_runtime["inference"]


def test_existing_run_is_never_overwritten(prepared: dict) -> None:
    prepared["run"].mkdir()
    marker = prepared["run"] / "keep.txt"
    marker.write_text("untouched")
    with pytest.raises(ValueError, match="fresh"):
        training.train_multitask(prepared["manifest"], prepared["run"])
    assert marker.read_text() == "untouched"


def test_decode_integrity_and_private_failure_message(prepared: dict) -> None:
    PIL = pytest.importorskip("PIL.Image")
    ImageOps = pytest.importorskip("PIL.ImageOps")
    row = training._manifest_preflight(prepared["manifest"], prepared["run"])["rows"]["validation"][0]
    Path(row["image_path"]).write_bytes(b"changed")
    with pytest.raises(RuntimeError) as caught:
        training._decode_image(row, lambda image: image, PIL, ImageOps)
    assert row["image_path"] not in str(caught.value) and row["sample_id"] not in str(caught.value)


def test_decode_applies_exif_orientation_and_rgb(tmp_path: Path) -> None:
    Image = pytest.importorskip("PIL.Image")
    ImageOps = pytest.importorskip("PIL.ImageOps")
    path = tmp_path / "image.jpg"
    image = Image.new("RGB", (12, 8), "blue")
    exif = image.getexif()
    exif[274] = 6
    image.save(path, exif=exif)
    row = {"image_path": str(path), "image_member": None, "image_sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    result = training._decode_image(row, lambda img: (img.size, img.mode), Image, ImageOps)
    assert result == ((8, 12), "RGB")


def test_validation_loader_has_no_augmentation_or_shuffle(prepared: dict) -> None:
    torch = pytest.importorskip("torch")
    transforms = pytest.importorskip("torchvision.transforms")
    rows = training._manifest_preflight(prepared["manifest"], prepared["run"])["rows"]
    loaders = training._loaders(torch, rows, 2, "cpu", 42, True)
    assert isinstance(loaders["train"].sampler, torch.utils.data.RandomSampler)
    assert isinstance(loaders["validation"].sampler, torch.utils.data.SequentialSampler)
    assert any(isinstance(item, transforms.RandomHorizontalFlip) for item in loaders["train"].dataset.transform.transforms)
    assert not any(isinstance(item, transforms.RandomHorizontalFlip) for item in loaders["validation"].dataset.transform.transforms)
    assert list(training._loaders(torch, rows, 2, "cpu", 42, False)) == ["validation"]


def test_real_tensor_training_full_epoch_and_strict_reload(prepared: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    torch = pytest.importorskip("torch")
    pytest.importorskip("torchvision")
    Image = pytest.importorskip("PIL.Image")
    # Reprepare real, harmless JPEGs instead of training on synthetic byte strings.
    for index, path in enumerate(sorted(prepared["source"].rglob("*.jpg"))):
        Image.new("RGB", (32, 24), (index * 20, 30, 150)).save(path)
    other_manifest = prepared["manifest"].with_name("real-manifest")
    prepare_multitask(prepared["source"], other_manifest)
    calls, initial = [], {}
    class Tiny(torch.nn.Module):
        def __init__(self, unfreeze: bool):
            super().__init__()
            self.backbone = torch.nn.Sequential(torch.nn.AdaptiveAvgPool2d(1), torch.nn.Flatten(), torch.nn.Linear(3, 4))
            self.backbone.requires_grad_(unfreeze)
            self.heads = torch.nn.ModuleDict({name: torch.nn.Linear(4, len(classes)) for name, classes in TARGETS.items()})
        def forward(self, images):
            features = self.backbone(images)
            return {name: head(features) for name, head in self.heads.items()}
    def factory(pretrained=False, unfreeze=False):
        calls.append((pretrained, unfreeze))
        model = Tiny(unfreeze)
        if pretrained:
            initial.update({key: value.clone() for key, value in model.state_dict().items()})
        return model
    monkeypatch.setattr(training, "create_multitask_model", factory)
    result = training.train_multitask(other_manifest, prepared["run"], epochs=2, batch_size=2, device="cpu")
    assert len(result["history"]) == 2
    assert all(entry["train_steps"] == 3 and entry["train_images"] == 5 for entry in result["history"])
    originals = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in prepared["run"].iterdir()}
    evaluated = training.evaluate_multitask(other_manifest, prepared["run"], device="cpu", batch_size=2)
    assert calls == [(True, False), (False, False)]
    assert evaluated["recorded_checkpoint_comparison"]["within_tolerance"]
    assert all(hashlib.sha256((prepared["run"] / name).read_bytes()).hexdigest() == digest for name, digest in originals.items())
    saved = torch.load(prepared["run"] / "checkpoint-best.pt", weights_only=True, map_location="cpu")
    assert all(torch.equal(value, saved["state_dict"][key]) for key, value in initial.items() if key.startswith("backbone."))
    assert any(not torch.equal(value, saved["state_dict"][key]) for key, value in initial.items() if key.startswith("heads."))
    saved["state_dict"].pop(next(iter(saved["state_dict"])))
    inputs = training._evaluation_preflight(other_manifest, prepared["run"], "best")
    with pytest.raises(ValueError, match="tensors"):
        training._evaluate_saved(torch, saved, inputs, "cpu", 2)


def test_factory_preserves_shared_feature_shape_and_never_downloads(monkeypatch: pytest.MonkeyPatch) -> None:
    torch = pytest.importorskip("torch")
    models = pytest.importorskip("torchvision.models")
    calls = []
    class Backbone(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.classifier = torch.nn.Sequential(torch.nn.Identity(), torch.nn.Flatten(), torch.nn.Linear(3, 1000))
        def forward(self, image):
            return self.classifier(image)
    def construct(**kwargs):
        calls.append(kwargs)
        return Backbone()
    monkeypatch.setattr(models, "convnext_tiny", construct)
    model = training.create_multitask_model(pretrained=False)
    assert calls == [{"weights": None, "progress": False}]
    assert all(not p.requires_grad for p in model.backbone.parameters())
    assert all(p.requires_grad for p in model.heads.parameters())
    assert {name: tuple(value.shape) for name, value in model(torch.zeros(2, 3)).items()} == {name: (2, len(classes)) for name, classes in TARGETS.items()}
