"""Synthetic offline evaluation contracts; no downloads, CUDA or private data."""

from contextlib import contextmanager
from copy import deepcopy
import csv
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
from types import ModuleType, SimpleNamespace
import warnings

import pytest

from senmiva_training.data import load_manifest, prepare_dataset
from senmiva_training import evaluation
from senmiva_training.trainer import confusion_metrics


def _write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


@pytest.fixture
def experiment(tmp_path: Path) -> dict:
    source = tmp_path / "source"
    for partition, labels in (("TS_source", ("NVP", "VP", "VP", "VP")), ("VS_source", ("NVP", "VP"))):
        for index, label in enumerate(labels):
            folder = source / partition / str(index)
            folder.mkdir(parents=True)
            stream = io.StringIO(newline="")
            writer = csv.writer(stream)
            writer.writerow(["No", "이미지 부위 (상/중/하)", "모공 (육안 평가)"])
            writer.writerow([f"{partition}-{index}", "중", label])
            (folder / "image.csv").write_bytes(stream.getvalue().encode("utf-8-sig"))
            (folder / "image.jpg").write_bytes(f"synthetic image {partition}-{index}".encode())
    manifest = tmp_path / "manifests"
    prepare_dataset(source, manifest)
    run = tmp_path / "run"
    run.mkdir()
    config = {
        "schema_version": 1,
        "task": "experimental_csv_pore_code_classification",
        "architecture": "torchvision.convnext_tiny",
        "classes": ["NVP", "VP"],
        "preprocessing": deepcopy(evaluation._PREPROCESSING),
        "epochs": 2, "seed": 42, "deterministic_algorithms": True,
        "grouping_verified": False, "device": "cpu", "mixed_precision": None,
        "manifest_sha256": {split: hashlib.sha256((manifest / f"{split}.jsonl").read_bytes()).hexdigest() for split in ("train", "validation")},
        "manifest_counts": {"train": 4, "validation": 2},
        "train_label_counts": {"NVP": 1, "VP": 3},
    }
    first = confusion_metrics([0, 1], [0, 1])
    first["weighted_cross_entropy"] = 0.4
    last = confusion_metrics([0, 1], [1, 1])
    last["weighted_cross_entropy"] = 0.7
    metrics = {
        "schema_version": 1, "status": "completed", "experimental": True, "production_ready": False,
        "grouping_verified": False, "manifest_sha256": config["manifest_sha256"],
        "best_epoch": 1, "best_validation": first,
        "history": [{"epoch": 1, "validation": first}, {"epoch": 2, "validation": last}],
    }
    checkpoints = {}
    for selection, epoch, validation in (("best", 1, first), ("last", 2, last)):
        (run / f"checkpoint-{selection}.pt").write_bytes(f"fake tensor checkpoint {selection}".encode())
        checkpoints[selection] = {
            "schema_version": 1, "architecture": config["architecture"], "classes": config["classes"],
            "preprocessing": deepcopy(config["preprocessing"]), "run_config": deepcopy(config),
            "epoch": epoch, "state_dict": {"fake.weight": "fake tensor"}, "validation_metrics": deepcopy(validation),
            "experimental": True, "production_ready": False,
        }
    _write_json(run / "run-config.json", config)
    _write_json(run / "metrics.json", metrics)
    return {"manifest": manifest, "run": run, "config": config, "metrics": metrics, "checkpoints": checkpoints}


@pytest.fixture
def runtime(monkeypatch: pytest.MonkeyPatch, experiment: dict) -> dict:
    calls = {"load": [], "inference": []}
    torch = ModuleType("torch")

    def load(path, **kwargs):
        calls["load"].append((Path(path).name, kwargs))
        return deepcopy(experiment["checkpoints"][Path(path).stem.removeprefix("checkpoint-")])

    def infer(torch_module, checkpoint, rows, config, device, batch_size):
        calls["inference"].append((checkpoint["epoch"], rows, device, batch_size))
        return deepcopy(checkpoint["validation_metrics"]), {"device": "cpu", "mixed_precision": None, "versions": {"torch": "synthetic"}}

    torch.load = load
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setattr(evaluation, "_evaluate_validation", infer)
    return calls


def test_import_does_not_load_torch_torchvision_or_pillow() -> None:
    source = str(Path(evaluation.__file__).resolve().parents[1])
    code = "import sys; sys.path.insert(0, " + repr(source) + "); import senmiva_training.evaluation; assert not any(name in sys.modules for name in ('torch', 'torchvision', 'PIL'))"
    completed = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert completed.returncode == 0, completed.stderr


@pytest.mark.parametrize("kwargs", [
    {"checkpoint": "../checkpoint-last.pt"}, {"checkpoint": "other"},
    {"device": "mps"}, {"batch_size": 0}, {"batch_size": 129}, {"batch_size": True}, {"batch_size": 1.0},
])
def test_invalid_options_fail_before_reading_or_loading(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kwargs: dict) -> None:
    def fail(*args, **kw):
        raise AssertionError("Preflight must not be entered")

    monkeypatch.setattr(evaluation, "_preflight", fail)
    with pytest.raises(ValueError):
        evaluation.evaluate_model(tmp_path / "absent-manifest", tmp_path / "absent-run", **kwargs)


@pytest.mark.parametrize("selection,epoch", [("best", 1), ("last", 2)])
def test_tensor_only_load_and_aggregate_reports_do_not_overwrite_training(experiment: dict, runtime: dict, selection: str, epoch: int) -> None:
    originals = {path.name: path.read_bytes() for path in experiment["run"].iterdir()}
    result = evaluation.evaluate_model(experiment["manifest"], experiment["run"], checkpoint=selection, device="cpu", batch_size=3)
    assert runtime["load"] == [(f"checkpoint-{selection}.pt", {"weights_only": True, "map_location": "cpu"})]
    assert runtime["inference"][0][0] == epoch
    assert result["checkpoint_epoch"] == epoch
    assert result["validation"]["sample_count"] == 2
    assert result["constant_baseline"]["predicted_class"] == "VP"
    assert result["constant_baseline"]["confusion_matrix"] == [[0, 1], [0, 1]]
    assert result["constant_baseline"]["balanced_accuracy"] == 0.5
    assert result["experimental"] and not result["production_ready"]
    assert not result["independent_test"] and not result["grouping_verified"]
    assert result["evaluation_split"] == "validation"
    assert result["recorded_checkpoint_comparison"]["within_tolerance"]
    report_dir = experiment["run"] / result["report_directory"]
    assert len(report_dir.name) == 32 and report_dir.parent.name == "evaluations"
    assert list(path.name for path in report_dir.iterdir()) == ["summary.json"]
    assert json.loads((report_dir / "summary.json").read_text(encoding="utf-8")) == result
    for name, content in originals.items():
        assert (experiment["run"] / name).read_bytes() == content
    payload = json.dumps(result)
    for split in ("train", "validation"):
        for row in load_manifest(experiment["manifest"] / f"{split}.jsonl"):
            for field in ("image_path", "sample_id", "group_id"):
                assert row[field] not in payload
    assert "state_dict" not in payload and "run_config" not in payload
    assert result["checkpoint_sha256"] == hashlib.sha256(originals[f"checkpoint-{selection}.pt"]).hexdigest()


def test_repeated_evaluations_save_distinct_reports(experiment: dict, runtime: dict) -> None:
    first = evaluation.evaluate_model(experiment["manifest"], experiment["run"])
    first_content = (experiment["run"] / first["report_directory"] / "summary.json").read_bytes()
    second = evaluation.evaluate_model(experiment["manifest"], experiment["run"])
    assert first["report_directory"] != second["report_directory"]
    assert (experiment["run"] / first["report_directory"] / "summary.json").read_bytes() == first_content


def test_changed_manifest_fails_before_checkpoint_load(experiment: dict, runtime: dict) -> None:
    with (experiment["manifest"] / "validation.jsonl").open("a", encoding="utf-8") as stream:
        stream.write("\n")
    with pytest.raises(ValueError, match="integrity"):
        evaluation.evaluate_model(experiment["manifest"], experiment["run"])
    assert runtime["load"] == []
    assert not (experiment["run"] / "evaluations").exists()


@pytest.mark.parametrize("field,value", [
    ("classes", ["VP", "NVP"]), ("architecture", "other.model"), ("grouping_verified", True),
    ("manifest_sha256", {"train": "0" * 64, "validation": "0" * 64}),
    ("manifest_counts", {"train": 5, "validation": 2}), ("train_label_counts", {"NVP": 3, "VP": 1}),
    ("preprocessing", {**evaluation._PREPROCESSING, "resize_short_edge": 224}),
    ("preprocessing", {**evaluation._PREPROCESSING, "exif_transpose": 1}),
    ("mixed_precision", "float64"),
])
def test_changed_run_configuration_fails_before_checkpoint_load(experiment: dict, runtime: dict, field: str, value) -> None:
    config = deepcopy(experiment["config"])
    config[field] = value
    _write_json(experiment["run"] / "run-config.json", config)
    with pytest.raises(ValueError):
        evaluation.evaluate_model(experiment["manifest"], experiment["run"])
    assert runtime["load"] == []


@pytest.mark.parametrize("field,value", [
    ("labels", ["VP", "NVP"]), ("grouping_verified", True),
    ("partitions", {"training": {"selected_records": 99, "selected_label_counts": {"NVP": 1, "VP": 3}}}),
])
def test_changed_preparation_summary_rejected(experiment: dict, runtime: dict, field: str, value) -> None:
    summary_path = experiment["manifest"] / "summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary[field] = value
    _write_json(summary_path, summary)
    with pytest.raises(ValueError):
        evaluation.evaluate_model(experiment["manifest"], experiment["run"])
    assert runtime["load"] == []


@pytest.mark.parametrize("field,value", [
    ("classes", ["VP", "NVP"]), ("architecture", "other.model"), ("epoch", True), ("epoch", 2),
    ("experimental", False), ("production_ready", True), ("state_dict", {}),
    ("preprocessing", {**evaluation._PREPROCESSING, "mean": [0.5, 0.5, 0.5]}),
    ("run_config", {}), ("validation_metrics", {}),
])
def test_changed_checkpoint_metadata_rejected_before_inference(experiment: dict, runtime: dict, field: str, value) -> None:
    experiment["checkpoints"]["best"][field] = value
    with pytest.raises(ValueError):
        evaluation.evaluate_model(experiment["manifest"], experiment["run"])
    assert runtime["inference"] == []
    assert not (experiment["run"] / "evaluations").exists()


def test_synchronized_but_inconsistent_recorded_metrics_are_rejected(experiment: dict, runtime: dict) -> None:
    experiment["checkpoints"]["best"]["validation_metrics"]["macro_f1"] = 0.1
    experiment["metrics"]["best_validation"]["macro_f1"] = 0.1
    _write_json(experiment["run"] / "metrics.json", experiment["metrics"])
    with pytest.raises(ValueError, match="internally inconsistent"):
        evaluation.evaluate_model(experiment["manifest"], experiment["run"])
    assert runtime["inference"] == []


def test_safe_load_failure_hides_upstream_paths(experiment: dict, runtime: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    def load(*args, **kwargs):
        raise RuntimeError("private-person-path.jpg")

    monkeypatch.setattr(sys.modules["torch"], "load", load)
    with pytest.raises(ValueError, match="safely loaded") as error:
        evaluation.evaluate_model(experiment["manifest"], experiment["run"])
    assert "private-person" not in str(error.value)
    assert runtime["inference"] == []


def test_inference_failure_does_not_create_an_evaluation_directory(experiment: dict, runtime: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    def infer(*args, **kwargs):
        raise RuntimeError("Synthetic bounded decode failure")

    monkeypatch.setattr(evaluation, "_evaluate_validation", infer)
    with pytest.raises(RuntimeError):
        evaluation.evaluate_model(experiment["manifest"], experiment["run"])
    assert not (experiment["run"] / "evaluations").exists()


def test_excessive_checkpoint_rejected_before_torch(experiment: dict, runtime: dict) -> None:
    with (experiment["run"] / "checkpoint-best.pt").open("wb") as stream:
        stream.truncate(evaluation._MAX_CHECKPOINT_BYTES + 1)
    with pytest.raises(ValueError, match="size limit"):
        evaluation.evaluate_model(experiment["manifest"], experiment["run"])
    assert runtime["load"] == []


def test_onedrive_run_is_rejected_before_reading_metadata(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="OneDrive"):
        evaluation.evaluate_model(tmp_path / "manifest", tmp_path / "OneDrive" / "run")


def _image_api(width: int = 500, height: int = 500, bomb_warning: bool = False):
    events = []

    class BombWarning(Warning):
        pass

    image = SimpleNamespace(width=width, height=height)

    def convert(mode):
        events.append(("convert", mode))
        return image

    image.convert = convert

    @contextmanager
    def opened(stream):
        events.append("open")
        if bomb_warning:
            warnings.warn("synthetic bomb", BombWarning)
        yield image

    def transpose(value):
        assert value is image
        events.append("exif")
        return image

    return SimpleNamespace(open=opened, DecompressionBombWarning=BombWarning), SimpleNamespace(exif_transpose=transpose), events


def test_validation_decode_checks_hash_then_applies_exif_rgb_transform(experiment: dict) -> None:
    row = load_manifest(experiment["manifest"] / "validation.jsonl")[0]
    image_api, ops, events = _image_api()

    def transform(image):
        events.append("transform")
        return "tensor"

    assert evaluation._decode_image(row, transform, image_api, ops) == "tensor"
    assert events == ["open", "exif", ("convert", "RGB"), "transform"]
    Path(row["image_path"]).write_bytes(b"changed image")
    with pytest.raises(RuntimeError, match="verified or decoded") as error:
        evaluation._decode_image(row, transform, image_api, ops)
    assert row["image_path"] not in str(error.value)
    assert len(events) == 4


@pytest.mark.parametrize("width,height,bomb_warning", [(5001, 5000, False), (100, 100, True)])
def test_pixel_limit_and_decompression_warning_fail_before_transform(experiment: dict, width: int, height: int, bomb_warning: bool) -> None:
    row = load_manifest(experiment["manifest"] / "validation.jsonl")[0]
    image_api, ops, events = _image_api(width, height, bomb_warning)
    with pytest.raises(RuntimeError):
        evaluation._decode_image(row, lambda image: pytest.fail("Transform must not run"), image_api, ops)
    assert events == ["open"]


def test_image_byte_limit_rejected_before_decoder(experiment: dict) -> None:
    row = load_manifest(experiment["manifest"] / "validation.jsonl")[0]
    with Path(row["image_path"]).open("wb") as stream:
        stream.truncate(40 * 1024 * 1024 + 1)
    image_api, ops, events = _image_api()
    with pytest.raises(RuntimeError):
        evaluation._decode_image(row, lambda image: pytest.fail("Transform must not run"), image_api, ops)
    assert events == []


def test_metric_comparison_reports_numerical_differences_without_claiming_independence() -> None:
    recorded = confusion_metrics([0, 1], [0, 1])
    recorded["weighted_cross_entropy"] = 0.4
    different = deepcopy(recorded)
    different["weighted_cross_entropy"] += 0.01
    comparison = evaluation._comparison(recorded, different, False)
    assert comparison["confusion_matrix_matches"]
    assert not comparison["within_tolerance"]
    assert not comparison["same_device_and_precision_as_training"]
    assert "not independent" in comparison["interpretation"]
    different["weighted_cross_entropy"] = 0.4 + 0.5e-6
    assert evaluation._comparison(recorded, different, True)["within_tolerance"]


@pytest.mark.parametrize("change", ["incomplete", "wrong_best", "invalid_score", "nonconsecutive"])
def test_inconsistent_training_history_is_rejected(experiment: dict, runtime: dict, change: str) -> None:
    metrics = deepcopy(experiment["metrics"])
    if change == "incomplete":
        metrics["history"].pop()
    elif change == "wrong_best":
        metrics["best_epoch"] = 2
        metrics["best_validation"] = metrics["history"][1]["validation"]
    elif change == "invalid_score":
        metrics["history"][1]["validation"]["balanced_accuracy"] = float("nan")
    else:
        metrics["history"][1]["epoch"] = 3
    _write_json(experiment["run"] / "metrics.json", metrics)
    with pytest.raises(ValueError):
        evaluation.evaluate_model(experiment["manifest"], experiment["run"])
    assert runtime["inference"] == []


def test_inference_uses_no_pretrained_weights_strict_load_and_only_validation(experiment: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    """Exercise the inference loop using a minimal CPU tensor runtime.

    No training methods, optimizer, gradient methods or download functions are
    provided: invoking any of them would fail this test.
    """
    events = []
    state = {"inference": False}

    class Tensor:
        def __init__(self, values):
            self.values = values

        def to(self, *args, **kwargs):
            return self

        def cpu(self):
            return self

        def tolist(self):
            return self.values

        def item(self):
            return self.values

        def all(self):
            return self

        def argmax(self, dim):
            assert dim == 1
            return Tensor([0, 1])

        def __getitem__(self, indexes):
            return Tensor([self.values[index] for index in indexes.values])

        def sum(self):
            return Tensor(sum(self.values))

    class Model:
        classifier = [SimpleNamespace(in_features=3)]

        def load_state_dict(self, values, strict):
            events.append(("load_state_dict", strict))
            assert values == experiment["checkpoints"]["best"]["state_dict"]

        def requires_grad_(self, value):
            events.append(("requires_grad", value))

        def to(self, device):
            assert device == "cpu"

        def eval(self):
            events.append("eval")

        def __call__(self, images):
            assert state["inference"]
            return Tensor([[1, 0], [0, 1]])

    @contextmanager
    def inference_mode():
        state["inference"] = True
        events.append("inference_mode")
        try:
            yield
        finally:
            state["inference"] = False

    @contextmanager
    def autocast(device, dtype, enabled):
        assert device == "cpu" and not enabled
        yield

    def factory(**kwargs):
        events.append(("convnext_tiny", kwargs))
        return Model()

    def loss_factory(**kwargs):
        assert kwargs["reduction"] == "sum"
        return lambda logits, labels: Tensor(0.4)

    def loader(dataset, **kwargs):
        assert kwargs == {"batch_size": 2, "shuffle": False, "num_workers": 0, "pin_memory": False}
        samples = [dataset[index] for index in range(len(dataset))]
        assert len(samples) == 2
        return [(Tensor([sample[0] for sample in samples]), Tensor([sample[1] for sample in samples]))]

    def resize(*args, **kwargs):
        events.append(("resize", args, kwargs))
        return "resize"

    def crop(size):
        events.append(("crop", size))
        return "crop"

    def normalize(**kwargs):
        events.append(("normalize", kwargs))
        return "normalize"

    torch = ModuleType("torch")
    torch.__version__ = "synthetic"
    torch.version = SimpleNamespace(cuda=None)
    torch.cuda = SimpleNamespace(is_available=lambda: False)
    torch.nn = SimpleNamespace(Linear=lambda width, classes: SimpleNamespace(in_features=width, out_features=classes), CrossEntropyLoss=loss_factory)
    torch.backends = SimpleNamespace(cudnn=SimpleNamespace(benchmark=None, deterministic=None))
    torch.manual_seed = lambda seed: events.append(("seed", seed))
    torch.use_deterministic_algorithms = lambda value: events.append(("deterministic", value))
    torch.bfloat16, torch.float16, torch.float32 = "bfloat16", "float16", "float32"
    torch.tensor = lambda values, **kwargs: Tensor(values)
    torch.isfinite = lambda tensor: Tensor(True)
    torch.inference_mode = inference_mode
    torch.amp = SimpleNamespace(autocast=autocast)
    data = ModuleType("torch.utils.data")
    data.Dataset, data.DataLoader = object, loader
    torchvision = ModuleType("torchvision")
    torchvision.__version__ = "synthetic"
    torchvision.transforms = SimpleNamespace(
        Resize=resize, CenterCrop=crop, ToTensor=lambda: "tensor", Normalize=normalize,
        Compose=lambda items: (lambda image: Tensor([0])),
        InterpolationMode=SimpleNamespace(BILINEAR="bilinear"),
    )
    models = ModuleType("torchvision.models")
    models.convnext_tiny = factory
    pillow = ModuleType("PIL")
    pillow.__version__ = "synthetic"
    pillow.Image, pillow.ImageOps, decode_events = _image_api()
    for name, value in (("torch", torch), ("torch.utils.data", data), ("torchvision", torchvision), ("torchvision.models", models), ("PIL", pillow)):
        monkeypatch.setitem(sys.modules, name, value)
    rows = {split: load_manifest(experiment["manifest"] / f"{split}.jsonl") for split in ("train", "validation")}
    # The test predictions follow label order, which pseudonym sorting can vary.
    rows["validation"].sort(key=lambda row: row["label"])
    # Training images are deliberately unavailable; evaluation must not open them.
    for row in rows["train"]:
        Path(row["image_path"]).unlink()
    metrics, runtime = evaluation._evaluate_validation(torch, experiment["checkpoints"]["best"], rows, experiment["config"], "cpu", 2)
    assert metrics["confusion_matrix"] == [[1, 0], [0, 1]]
    assert runtime["device"] == "cpu" and runtime["mixed_precision"] is None
    assert ("convnext_tiny", {"weights": None, "progress": False}) in events
    assert ("load_state_dict", True) in events
    assert ("requires_grad", False) in events
    assert "eval" in events and "inference_mode" in events
    assert ("resize", (236,), {"interpolation": "bilinear", "antialias": True}) in events
    assert ("crop", 224) in events
    assert ("normalize", {"mean": evaluation._PREPROCESSING["mean"], "std": evaluation._PREPROCESSING["std"]}) in events
    assert decode_events.count("open") == 2
