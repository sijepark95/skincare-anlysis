"""Synthetic in-memory personal-photo inference, without private fixtures."""

from copy import deepcopy
import csv
import io
import json
from pathlib import Path
import subprocess
import sys

import pytest

from senmiva_training import multitask_training as training
from senmiva_training import photo_inference as inference
from senmiva_training.multitask_data import REGION_COLUMN, TARGET_COLUMNS, TARGETS, prepare_multitask


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


def image_bytes(format: str = "PNG", size: tuple[int, int] = (320, 256), **kwargs) -> bytes:
    Image = pytest.importorskip("PIL.Image")
    image = Image.new("RGB", size, (128, 96, 160))
    stream = io.BytesIO()
    image.save(stream, format=format, **kwargs)
    image.close()
    return stream.getvalue()


@pytest.fixture
def experiment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict:
    torch = pytest.importorskip("torch")

    class Tiny(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.heads = torch.nn.ModuleDict({key: torch.nn.Linear(3, len(codes)) for key, codes in TARGETS.items()})
            for head in self.heads.values():
                torch.nn.init.constant_(head.weight, 0.1)
                with torch.no_grad():
                    head.bias.copy_(torch.arange(len(head.bias), dtype=torch.float32))

        def forward(self, image):
            assert not self.training and not torch.is_grad_enabled()
            return {key: head(image.mean(dim=(2, 3))) for key, head in self.heads.items()}

    source = tmp_path / "private-source"
    for split in ("TS_source", "VS_source"):
        for index in range(3):
            folder = source / split / str(index)
            folder.mkdir(parents=True)
            stream = io.StringIO(newline="")
            writer = csv.writer(stream)
            writer.writerow([REGION_COLUMN, *TARGET_COLUMNS.values()])
            writer.writerow(["중", *(codes[index % len(codes)] for codes in TARGETS.values())])
            (folder / "sample.csv").write_text(stream.getvalue(), encoding="utf-8-sig")
            (folder / "sample.jpg").write_bytes(f"synthetic pixels {split}-{index}".encode())
    manifest, run = tmp_path / "manifest", tmp_path / "model-run"
    prepare_multitask(source, manifest)
    run.mkdir()
    inputs = training._manifest_preflight(manifest, run)
    config = {"schema_version": 1, "task": training.TASK, "architecture": training.ARCHITECTURE,
              "target_schema": training._schema(), "preprocessing": deepcopy(training.PREPROCESSING),
              "epochs": 1, "seed": 42, "device": "cpu", "mixed_precision": None,
              "grouping_verified": False, "region_label_compatibility_verified": False, "label_semantics_verified": False,
              "experimental": True, "production_ready": False, "deterministic_algorithms": True,
              **{key: inputs[key] for key in ("manifest_sha256", "manifest_counts", "train_label_counts", "preparation_summary_sha256")}}
    rows = inputs["rows"]["validation"]
    report = training._aggregate(rows, {key: [codes.index(row["labels"][key]) for row in rows] for key, codes in TARGETS.items()},
                                 {key: 0.4 for key in TARGETS}, inputs["train_label_counts"])
    metrics = {"schema_version": 1, "status": "completed", "experimental": True, "production_ready": False,
               "grouping_verified": False, "target_schema": training._schema(), "manifest_sha256": inputs["manifest_sha256"],
               "best_epoch": 1, "best_validation": report, "history": [{"epoch": 1, "validation": report}]}
    saved = {"schema_version": 1, "architecture": training.ARCHITECTURE, "target_schema": training._schema(),
             "preprocessing": deepcopy(training.PREPROCESSING), "run_config": config, "epoch": 1,
             "state_dict": Tiny().state_dict(), "validation_metrics": report, "experimental": True, "production_ready": False}
    for selection in ("best", "last"):
        torch.save(saved, run / f"checkpoint-{selection}.pt")
    write_json(run / "run-config.json", config)
    write_json(run / "metrics.json", metrics)
    calls = []

    def factory(pretrained=False):
        calls.append(pretrained)
        return Tiny()

    monkeypatch.setattr(training, "create_multitask_model", factory)
    return {"source": source, "manifest": manifest, "run": run, "saved": saved,
            "metrics": metrics, "factory_calls": calls, "torch": torch}


def predictor(experiment: dict, **kwargs) -> inference.PhotoPredictor:
    return inference.PhotoPredictor(experiment["manifest"], experiment["run"], device="cpu", **kwargs)


def test_import_remains_lazy() -> None:
    source = str(Path(inference.__file__).resolve().parents[1])
    result = subprocess.run([sys.executable, "-c", f"import sys; sys.path.insert(0,{source!r}); import senmiva_training.photo_inference; assert not any(k in sys.modules for k in ('torch','torchvision','PIL'))"],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("selection", ["best", "last"])
def test_tensor_only_reload_and_safe_metadata(experiment: dict, monkeypatch: pytest.MonkeyPatch, selection: str) -> None:
    torch = experiment["torch"]
    original = torch.load
    loads = []

    def load(path, **kwargs):
        loads.append(kwargs)
        return original(path, **kwargs)

    monkeypatch.setattr(torch, "load", load)
    model = predictor(experiment, checkpoint=selection)
    assert loads == [{"weights_only": True, "map_location": "cpu"}]
    assert experiment["factory_calls"] == [False]
    info = model.metadata()
    assert info["mode"] == inference.MODE and info["model_run"] == "model-run"
    assert info["checkpoint"] == selection and info["checkpoint_epoch"] == 1 and info["device"] == "cpu"
    assert len(info["targets"]) == 8 and info["max_image_bytes"] == 10 * 1024 * 1024
    assert info["min_image_edge"] == 224 and info["max_decoded_pixels"] == 25_000_000
    assert info["targets"][0] == {"key": "sensitivity", "label": "민감성", "codes": ["NS", "S"]}
    assert "softmax" in " ".join(info["warnings"])
    assert all(not value.requires_grad for value in model._model.parameters())
    payload = json.dumps(info)
    assert str(experiment["source"]) not in payload and "image_path" not in payload and "sha256" not in payload
    info["targets"][0]["codes"].clear()
    assert model.metadata()["targets"][0]["codes"] == ["NS", "S"]


@pytest.mark.parametrize("format", ["PNG", "JPEG", "WEBP"])
def test_predicts_all_heads_without_writes_or_source_pixel_reads(experiment: dict, monkeypatch: pytest.MonkeyPatch, format: str) -> None:
    originals = {path: path.read_bytes() for path in experiment["run"].parent.rglob("*") if path.is_file()}
    read_bytes = Path.read_bytes

    def safe_read(path):
        if path.suffix.casefold() == ".jpg" and path.is_relative_to(experiment["source"]):
            pytest.fail("Inference must not read any original dataset image")
        return read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", safe_read)
    model = predictor(experiment)
    output = model.predict_image(image_bytes(format))
    assert output["schema_version"] == 1 and output["mode"] == inference.MODE
    assert output["input"] == {"width": 320, "height": 256}
    assert len(output["heads"]) == 8
    for head in output["heads"]:
        codes = TARGETS[head["key"]]
        assert head["predicted_code"] == codes[-1]
        assert [value["code"] for value in head["probabilities"]] == list(codes)
        probabilities = [value["probability"] for value in head["probabilities"]]
        assert sum(probabilities) == pytest.approx(1, abs=1e-6) and all(0 <= value <= 1 for value in probabilities)
    serialized = json.dumps(output)
    assert all(key not in serialized for key in ("image_path", "image_sha256", "state_dict", "sample_id", str(experiment["source"])))
    after = {path: read_bytes(path) for path in experiment["run"].parent.rglob("*") if path.is_file()}
    assert originals == after


def test_exact_evaluation_transform_and_exif_orientation(experiment: dict) -> None:
    Image = pytest.importorskip("PIL.Image")
    ImageOps = pytest.importorskip("PIL.ImageOps")
    from torchvision import transforms
    torch = experiment["torch"]
    model = predictor(experiment)
    exif = Image.Exif()
    exif[274] = 6
    payload = image_bytes("JPEG", (320, 256), exif=exif)
    tensor, dimensions = model._decode(payload)
    assert dimensions == {"width": 256, "height": 320}
    with Image.open(io.BytesIO(payload)) as source:
        expected = transforms.Compose([
            transforms.Resize(236, interpolation=transforms.InterpolationMode.BILINEAR, antialias=True),
            transforms.CenterCrop(224), transforms.ToTensor(),
            transforms.Normalize(mean=training.PREPROCESSING["mean"], std=training.PREPROCESSING["std"]),
        ])(ImageOps.exif_transpose(source).convert("RGB"))
    assert tuple(tensor.shape) == (3, 224, 224) and torch.equal(tensor, expected)


@pytest.mark.parametrize("payload", [b"", b"not image secret-marker", bytearray(b"invalid"), None])
def test_rejects_invalid_input_without_disclosing_payload(experiment: dict, payload) -> None:
    with pytest.raises(inference.PhotoInputError) as error:
        predictor(experiment).predict_image(payload)
    assert "secret-marker" not in str(error.value)


def test_rejects_byte_limit_before_decoder(experiment: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    model = predictor(experiment)
    monkeypatch.setattr(model._Image, "open", lambda *args: pytest.fail("Byte limit must precede decoding"))
    with pytest.raises(inference.PhotoInputError, match="10 MiB"):
        model.predict_image(b"a" * (inference.MAX_IMAGE_BYTES + 1))


@pytest.mark.parametrize("size", [(223, 256), (256, 223), (1, 1)])
def test_rejects_tiny_images(experiment: dict, size) -> None:
    with pytest.raises(inference.PhotoInputError, match="224 pixels"):
        predictor(experiment).predict_image(image_bytes(size=size))


@pytest.mark.parametrize("format", ["GIF", "BMP", "TIFF"])
def test_rejects_unapproved_formats(experiment: dict, format) -> None:
    with pytest.raises(inference.PhotoInputError, match="static JPEG"):
        predictor(experiment).predict_image(image_bytes(format))


def test_rejects_animated_png(experiment: dict) -> None:
    Image = pytest.importorskip("PIL.Image")
    first, second = Image.new("RGB", (256, 256), "red"), Image.new("RGB", (256, 256), "blue")
    stream = io.BytesIO()
    first.save(stream, format="PNG", save_all=True, append_images=[second], duration=100, loop=0)
    with pytest.raises(inference.PhotoInputError, match="static JPEG"):
        predictor(experiment).predict_image(stream.getvalue())
    first.close()
    second.close()


def test_rejects_pixel_limit_and_corrupt_images(experiment: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    model = predictor(experiment)
    monkeypatch.setattr(inference, "MAX_DECODED_PIXELS", 100_000)
    with pytest.raises(inference.PhotoInputError, match="25 million"):
        model.predict_image(image_bytes(size=(512, 512)))
    with pytest.raises(inference.PhotoInputError, match="static JPEG"):
        model.predict_image(image_bytes()[:100])


@pytest.mark.parametrize("kwargs", [{"checkpoint": "../secret"}, {"device": "mps"}])
def test_bad_options_fail_before_reads(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kwargs: dict) -> None:
    monkeypatch.setattr(training, "_evaluation_preflight", lambda *args: pytest.fail("No reads expected"))
    with pytest.raises(ValueError):
        inference.PhotoPredictor(tmp_path / "manifest", tmp_path / "run", **kwargs)


def test_rejects_incomplete_runs_before_checkpoint_loading(experiment: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    metrics = deepcopy(experiment["metrics"])
    metrics["status"] = "in_progress"
    write_json(experiment["run"] / "metrics.json", metrics)
    monkeypatch.setattr(experiment["torch"], "load", lambda *args, **kwargs: pytest.fail("No checkpoint load expected"))
    with pytest.raises(ValueError, match="completed local model"):
        predictor(experiment)


def test_changed_manifest_is_rejected_before_checkpoint_loading(experiment: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    with (experiment["manifest"] / "train.jsonl").open("a", encoding="utf-8") as stream:
        stream.write("\n")
    monkeypatch.setattr(experiment["torch"], "load", lambda *args, **kwargs: pytest.fail("No checkpoint load expected"))
    with pytest.raises(ValueError, match="could not be verified"):
        predictor(experiment)


def test_checkpoint_changed_during_load_is_rejected(experiment: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    original = experiment["torch"].load

    def load(path, **kwargs):
        saved = original(path, **kwargs)
        Path(path).write_bytes(b"changed after reading")
        return saved

    monkeypatch.setattr(experiment["torch"], "load", load)
    with pytest.raises(ValueError, match="changed during loading"):
        predictor(experiment)


@pytest.mark.parametrize("mutation", ["metadata", "tensor_type", "tensor_shape", "tensor_extra", "tensor_nan"])
def test_invalid_checkpoint_fails_closed(experiment: dict, mutation: str) -> None:
    torch = experiment["torch"]
    saved = deepcopy(experiment["saved"])
    if mutation == "metadata":
        saved["epoch"] = 2
    elif mutation == "tensor_type":
        saved["state_dict"]["heads.pores.weight"] = "not a tensor"
    elif mutation == "tensor_shape":
        saved["state_dict"]["heads.pores.weight"] = torch.zeros(1, 1)
    elif mutation == "tensor_extra":
        saved["state_dict"]["unexpected.weight"] = torch.zeros(1)
    else:
        saved["state_dict"]["heads.pores.weight"][0, 0] = float("nan")
    torch.save(saved, experiment["run"] / "checkpoint-best.pt")
    with pytest.raises(ValueError, match="could not be verified"):
        predictor(experiment)


@pytest.mark.parametrize("mutation", ["missing", "extra", "shape", "nan", "integer", "overflow"])
def test_invalid_logits_never_return_results(experiment: dict, monkeypatch: pytest.MonkeyPatch, mutation: str) -> None:
    model = predictor(experiment)
    torch = experiment["torch"]
    original = model._model.forward

    def forward(images):
        logits = original(images)
        if mutation == "missing":
            logits.pop("pores")
        elif mutation == "extra":
            logits["unknown"] = torch.zeros(1, 2)
        elif mutation == "shape":
            logits["pores"] = torch.zeros(2, 2)
        elif mutation == "nan":
            logits["pores"][0, 0] = float("nan")
        elif mutation == "integer":
            logits["pores"] = torch.zeros(1, 2, dtype=torch.int64)
        else:
            logits["pores"] = torch.full((1, 2), 1e300, dtype=torch.float64)
        return logits

    monkeypatch.setattr(model._model, "forward", forward)
    with pytest.raises(RuntimeError, match="No result was saved"):
        model.predict_image(image_bytes())


def test_missing_manifest_errors_do_not_expose_paths(tmp_path: Path) -> None:
    with pytest.raises(ValueError) as error:
        inference.PhotoPredictor(tmp_path / "sensitive-folder", tmp_path / "sensitive-model")
    assert "sensitive-folder" not in str(error.value) and str(tmp_path) not in str(error.value)
