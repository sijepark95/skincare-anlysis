"""Synthetic-only comparison governance/plumbing; no model weights or API calls."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import os
import subprocess
import sys
import time

import pytest

from senmiva_training import vision_comparison as comparison
from senmiva_training import vision_api
from senmiva_training.cli import main
from senmiva_training.multitask_data import TARGETS


NOW = datetime(2026, 10, 11, 12, tzinfo=timezone.utc)


def write(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


def image_bytes(size=(320, 256), *, exif=False) -> bytes:
    from PIL import Image
    with Image.new("RGB", size, (96, 128, 160)) as image:
        output = io.BytesIO()
        metadata = Image.Exif()
        if exif:
            metadata[274] = 6
            metadata[315] = "PRIVATE ARTIST NAME"
        image.save(output, format="JPEG", exif=metadata)
        return output.getvalue()


@pytest.fixture
def study(tmp_path: Path) -> dict:
    workspace = tmp_path / "private"
    comparison.comparison_init(workspace, "pilot-001", now=NOW)
    root = workspace / "comparisons" / "pilot-001"
    manifest = json.loads((root / "manifest.json").read_text())
    consent = {
        "consent_id": "c-1111111111111111", "participant_group": "p-1111111111111111",
        "notice_version": comparison.NOTICE_VERSION,
        **{key: True for key in comparison._ATTESTATIONS},
        "accepted_at": NOW.isoformat(), "expires_at": (NOW + timedelta(days=14)).isoformat(), "revoked_at": None,
    }
    raw = image_bytes(exif=True)
    photo = {"photo_id": "e-1111111111111111", "participant_group": consent["participant_group"],
             "consent_id": consent["consent_id"], "file": "images/e-1111111111111111.jpg",
             "sha256": hashlib.sha256(raw).hexdigest()}
    (root / photo["file"]).write_bytes(raw)
    manifest["photos"] = [photo]
    consents = {"schema_version": 1, "notice_version": comparison.NOTICE_VERSION, "participants": [consent]}
    write(root / "manifest.json", manifest); write(root / "consents.json", consents)
    model = workspace / "runs" / "skin-all-head-001"
    model.mkdir(parents=True)
    (model / "checkpoint-best.pt").write_bytes(b"synthetic checkpoint, never loaded by Torch")
    return {"workspace": workspace, "root": root, "manifest": manifest, "consents": consents, "photo": photo, "raw": raw}


def local_heads() -> list[dict]:
    return [{"key": key, "label": "research", "predicted_code": codes[0],
             "probabilities": [{"code": code, "probability": 1 / len(codes)} for code in codes]}
            for key, codes in TARGETS.items()]


def adapters(study, *, mutate=None, raise_api=False):
    inputs = {"local": [], "api": []}
    class Predictor:
        def __init__(self, *args, **kwargs):
            pass
        def predict_image(self, payload):
            inputs["local"].append(payload)
            return {"heads": local_heads()}
    class Api:
        def __init__(self, key):
            assert key == "sk-" + "x" * 20
        def analyze(self, payload):
            journal = study["root"] / "runs" / "paired-001" / "attempts.jsonl"
            assert json.loads(journal.read_text().splitlines()[-1])["event"] == "external_attempt_claimed"
            inputs["api"].append(payload)
            if mutate:
                mutate()
            if raise_api:
                raise RuntimeError("private filename/body/key must not persist")
            return vision_api.VisionApiResult("completed", vision_api.PINNED_MODEL,
                {"image_quality": "usable", "quality_flags": [],
                 "observed_features": {key: "not_visible" for key in vision_api.FEATURES}},
                vision_api.VisionUsage(100, 20, 120), 5)
    return inputs, Predictor, Api


def run(study, monkeypatch, **kwargs):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-" + "x" * 20)
    inputs, predictor, api = adapters(study, **kwargs)
    result = comparison.comparison_run(study["workspace"], "pilot-001", "paired-001", now=NOW,
                                      send_to_openai=True, predictor_factory=predictor, api_factory=api)
    return result, inputs


def test_init_creates_only_empty_private_templates_and_never_replaces(tmp_path):
    workspace = tmp_path / "private"
    result = comparison.comparison_init(workspace, "pilot", now=NOW)
    assert result["status"] == "needs_photos"
    root = workspace / "comparisons" / "pilot"
    assert list((root / "images").iterdir()) == []
    assert json.loads((root / "manifest.json").read_text())["photos"] == []
    template = json.loads((root / "consent-template.json").read_text())
    assert all(template[key] is False for key in comparison._ATTESTATIONS)
    with pytest.raises(FileExistsError):
        comparison.comparison_init(workspace, "pilot", now=NOW)


def test_import_is_independent_of_pillow_torch_and_external_adapters():
    code = "import sys; import senmiva_training.vision_comparison; assert 'torch' not in sys.modules; assert 'PIL' not in sys.modules; assert 'senmiva_training.vision_api' not in sys.modules"
    process = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")})
    assert process.returncode == 0


def test_generated_record_write_refuses_a_redirected_parent(tmp_path, monkeypatch):
    folder = tmp_path / "private"
    folder.mkdir()
    original = Path.resolve
    def resolve(path, *args, **kwargs):
        return tmp_path / "elsewhere" if path == folder else original(path, *args, **kwargs)
    monkeypatch.setattr(Path, "resolve", resolve)
    with pytest.raises(comparison.ComparisonError, match="original private folder"):
        comparison._append(folder / "attempts.jsonl", {"event": "synthetic"})


def test_empty_check_and_dry_run_do_not_read_sources_models_or_keys(tmp_path, monkeypatch):
    workspace = tmp_path / "private"
    comparison.comparison_init(workspace, "pilot", now=NOW)
    def forbidden(*args, **kwargs):
        raise AssertionError("must not enter source/model/key/network adapter")
    monkeypatch.setattr(comparison, "_api_key", forbidden)
    monkeypatch.setattr(comparison, "_source_exclusions", forbidden)
    result = comparison.comparison_run(workspace, "pilot", "dry", now=NOW,
                                      predictor_factory=forbidden, api_factory=forbidden)
    assert result["dry_run"] is True and result["api_requests"] == 0
    assert result["status"] == "needs_photos" and not (workspace / "comparisons" / "pilot" / "runs").exists()


def test_nonempty_dry_run_validates_hashes_without_loading_credentials_or_models(study, monkeypatch):
    monkeypatch.setattr(comparison, "_api_key", lambda *args: pytest.fail("dry run loaded key"))
    result = comparison.comparison_run(study["workspace"], "pilot-001", "dry", now=NOW,
        openai_env_file=Path("nonexistent.env"), predictor_factory=lambda *args: pytest.fail("loaded model"))
    assert result["status"] == "ready" and result["models_loaded"] is False
    assert result["exact_training_hash_exclusion"] is True


@pytest.mark.parametrize("field", comparison._ATTESTATIONS)
def test_every_independent_external_consent_is_required_before_photo_read(study, monkeypatch, field):
    study["consents"]["participants"][0][field] = False
    write(study["root"] / "consents.json", study["consents"])
    monkeypatch.setattr(comparison, "_photo_bytes", lambda *args: pytest.fail("read unconsented image"))
    with pytest.raises(comparison.ComparisonError, match="consent"):
        comparison.comparison_check(study["workspace"], "pilot-001", now=NOW)


@pytest.mark.parametrize("change", [
    {"revoked_at": NOW.isoformat()}, {"notice_version": "ingredient-only-kiosk-consent"},
    {"accepted_at": (NOW + timedelta(minutes=1)).isoformat()},
    {"expires_at": NOW.isoformat()}, {"adult": 1}, {"external_processing": "yes"},
])
def test_invalid_or_revoked_consent_fails_closed(study, change):
    study["consents"]["participants"][0].update(change)
    write(study["root"] / "consents.json", study["consents"])
    with pytest.raises(comparison.ComparisonError):
        comparison.comparison_check(study["workspace"], "pilot-001", now=NOW)


@pytest.mark.parametrize("change", [
    {"file": "../source.jpg"}, {"file": "C:/private/person.jpg"}, {"file": "images/name.jpg"},
    {"photo_id": "customer-name"}, {"sha256": "bad"}, {"consent_id": []}, {"extra": "private"},
])
def test_manifest_fields_are_fixed_opaque_and_bounded(study, change):
    study["manifest"]["photos"][0].update(change)
    write(study["root"] / "manifest.json", study["manifest"])
    with pytest.raises(comparison.ComparisonError):
        comparison.comparison_check(study["workspace"], "pilot-001", now=NOW)


def test_duplicate_json_keys_and_nonfinite_values_are_rejected(study):
    path = study["root"] / "manifest.json"
    for text in ('{"schema_version":1,"schema_version":1}', '{"schema_version":NaN}'):
        path.write_text(text)
        with pytest.raises(comparison.ComparisonError):
            comparison.comparison_check(study["workspace"], "pilot-001", now=NOW)


def test_duplicate_images_and_changed_bytes_are_rejected(study):
    study["manifest"]["photos"].append(deepcopy(study["photo"]))
    write(study["root"] / "manifest.json", study["manifest"])
    with pytest.raises(comparison.ComparisonError):
        comparison.comparison_check(study["workspace"], "pilot-001", now=NOW)
    study["manifest"]["photos"].pop(); write(study["root"] / "manifest.json", study["manifest"])
    (study["root"] / study["photo"]["file"]).write_bytes(b"changed")
    with pytest.raises(comparison.ComparisonError, match="SHA256"):
        comparison.comparison_check(study["workspace"], "pilot-001", now=NOW)


def test_copied_training_hash_is_rejected_without_reading_source_pixels(study):
    folder = study["workspace"] / "manifests" / "training"
    folder.mkdir(parents=True)
    (folder / "train.jsonl").write_text(json.dumps({"image_sha256": study["photo"]["sha256"], "image_path": "NEVER OPEN"}) + "\n")
    with pytest.raises(comparison.ComparisonError, match="overlaps"):
        comparison.comparison_check(study["workspace"], "pilot-001", now=NOW)


def test_registered_source_root_is_excluded(study):
    write(study["workspace"] / "dataset.json", {"root_path": str(study["root"] / "images")})
    with pytest.raises(comparison.ComparisonError, match="overlaps"):
        comparison.comparison_check(study["workspace"], "pilot-001", now=NOW)


def test_resolved_images_junction_escape_is_rejected_even_without_symlink_flag(study, monkeypatch, tmp_path):
    original = Path.resolve
    external = tmp_path / "outside"
    external.mkdir()
    image_root = study["root"] / "images"
    def resolve(path, *args, **kwargs):
        if path == image_root:
            return external
        if path == study["root"] / study["photo"]["file"]:
            return external / Path(study["photo"]["file"]).name
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, "resolve", resolve)
    with pytest.raises(comparison.ComparisonError, match="outside"):
        comparison.comparison_check(study["workspace"], "pilot-001", now=NOW)


def test_canonical_jpeg_is_deterministic_oriented_rgb_without_metadata(study):
    from PIL import Image
    raw = comparison.canonical_jpeg(study["raw"])
    assert raw == comparison.canonical_jpeg(study["raw"])
    assert b"PRIVATE ARTIST" not in raw and b"Exif" not in raw
    with Image.open(io.BytesIO(raw)) as image:
        assert image.mode == "RGB" and image.size == (256, 320)
        assert not image.getexif() and "icc_profile" not in image.info
    vision_api._validate_jpeg(raw)


@pytest.mark.parametrize("raw", [b"invalid", b"", image_bytes((223, 320))])
def test_invalid_canonical_image_fails_without_upload(raw):
    with pytest.raises(comparison.ComparisonError):
        comparison.canonical_jpeg(raw)


def test_real_run_uses_same_jpeg_pins_provenance_and_claims_before_api(study, monkeypatch):
    result, inputs = run(study, monkeypatch)
    assert result["api_requests"] == 1 and result["api_completed"] == 1
    assert inputs["local"] == inputs["api"] and inputs["api"][0] != study["raw"]
    folder = study["root"] / "runs" / "paired-001"
    config = json.loads((folder / "run-config.json").read_text())
    assert config["openai"]["prompt_sha256"] == vision_api.PROMPT_SHA256
    assert config["local_model"]["checkpoint_sha256"] == hashlib.sha256(b"synthetic checkpoint, never loaded by Torch").hexdigest()
    assert config["shared_preprocessing"]["same_internal_tensors"] is False
    rows = [json.loads(line) for line in (folder / "results.jsonl").read_text().splitlines()]
    assert rows[0]["shared_jpeg_sha256"] == hashlib.sha256(inputs["api"][0]).hexdigest()
    assert rows[0]["local"]["heads"] == local_heads()
    assert not any(path.suffix in (".jpg", ".jpeg", ".png", ".webp") for path in folder.iterdir())
    with pytest.raises(comparison.ComparisonError, match="immutable"):
        run(study, monkeypatch)


def test_api_exception_saves_only_safe_status_and_never_retries(study, monkeypatch):
    result, inputs = run(study, monkeypatch, raise_api=True)
    assert result["api_requests"] == 1 and len(inputs["api"]) == 1
    text = (study["root"] / "runs" / "paired-001" / "results.jsonl").read_text()
    assert "private filename" not in text
    row = json.loads(text)
    assert row["openai"]["failure_kind"] == "transport_error"
    assert row["openai"]["latency_ms"] >= 0


def test_revocation_during_api_prevents_result_persistence_and_purges_claim(study, monkeypatch):
    def revoke():
        study["consents"]["participants"][0]["revoked_at"] = NOW.isoformat()
        write(study["root"] / "consents.json", study["consents"])
    with pytest.raises(comparison.ComparisonError):
        run(study, monkeypatch, mutate=revoke)
    folder = study["root"] / "runs" / "paired-001"
    assert (folder / "attempts.jsonl").exists() and not (folder / "results.jsonl").exists()
    assert comparison.comparison_purge(study["workspace"], "pilot-001", now=NOW)["purged_runs"] == 1
    assert not (folder / "attempts.jsonl").exists() and (folder / "purged.json").exists()
    assert (study["root"] / study["photo"]["file"]).exists()


def test_expiry_purge_preserves_originals_and_prevents_report(study, monkeypatch):
    run(study, monkeypatch)
    result = comparison.comparison_purge(study["workspace"], "pilot-001", now=NOW + timedelta(days=15))
    folder = study["root"] / "runs" / "paired-001"
    assert result["purged_runs"] == 1 and not (folder / "results.jsonl").exists()
    assert (study["root"] / "manifest.json").exists()
    with pytest.raises(comparison.ComparisonError, match="purged"):
        comparison.comparison_report(study["workspace"], "pilot-001", "paired-001", now=NOW)


def test_report_is_aggregate_only_and_immutable(study, monkeypatch):
    run(study, monkeypatch)
    report = comparison.comparison_report(study["workspace"], "pilot-001", "paired-001", now=NOW)
    text = json.dumps(report)
    assert study["photo"]["photo_id"] not in text and study["photo"]["participant_group"] not in text
    assert report["decision"]["accuracy_comparison_available"] is False
    assert report["attempt_journal"]["uncertain"] == 0
    with pytest.raises(comparison.ComparisonError, match="already exists"):
        comparison.comparison_report(study["workspace"], "pilot-001", "paired-001", now=NOW)


def test_budget_refuses_before_key_or_model(study, monkeypatch):
    monkeypatch.setattr(comparison, "_api_key", lambda *args: pytest.fail("loaded key"))
    with pytest.raises(comparison.ComparisonError, match="budget"):
        comparison.comparison_run(study["workspace"], "pilot-001", "paired-001", send_to_openai=True, now=NOW, max_api_calls=0)


def test_cli_new_comparison_commands_do_not_require_dataset_registry(tmp_path, capsys):
    workspace = tmp_path / "private"
    assert main(["--workspace", str(workspace), "comparison-init", "--name", "empty"]) == 0
    assert main(["--workspace", str(workspace), "comparison-check", "--name", "empty"]) == 0
    assert main(["--workspace", str(workspace), "comparison-run", "--name", "empty", "--comparison-run", "dry"]) == 0
    output = capsys.readouterr().out
    assert str(tmp_path) not in output and '"dry_run": true' in output


def test_explicit_all_results_purge_works_without_consents_and_leaves_originals(study, monkeypatch):
    run(study, monkeypatch)
    (study["root"] / "consents.json").unlink()
    result = comparison.comparison_purge(study["workspace"], "pilot-001", all_results=True, now=NOW)
    assert result["purged_runs"] == 1
    assert (study["root"] / study["photo"]["file"]).exists()


def test_empty_crash_orphan_does_not_block_expired_cleanup(study, monkeypatch):
    run(study, monkeypatch)
    orphan = study["root"] / "runs" / "empty-orphan"
    orphan.mkdir()
    result = comparison.comparison_purge(study["workspace"], "pilot-001", now=NOW + timedelta(days=15))
    assert result["purged_runs"] == 2 and (orphan / "purged.json").exists()


def test_uncertain_crashed_external_claim_is_not_retried_and_reported_unknown(study, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-" + "x" * 20)
    inputs, predictor, api = adapters(study)
    class CrashApi(api):
        def analyze(self, payload):
            raise KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):
        comparison.comparison_run(study["workspace"], "pilot-001", "paired-001", now=NOW,
            send_to_openai=True, predictor_factory=predictor, api_factory=CrashApi)
    with pytest.raises(comparison.ComparisonError, match="immutable"):
        run(study, monkeypatch)
    report = comparison.comparison_report(study["workspace"], "pilot-001", "paired-001", now=NOW)
    assert report["attempt_journal"]["uncertain"] == 1
    assert report["attempt_journal"]["automatic_retry_permitted"] is False


@pytest.mark.parametrize("field,value", [
    ("photo_count", 0), ("notice_version", "kiosk-ingredient-only"),
    ("code_mapping_verified", True), ("openai", {"model": "unapproved"}),
    ("shared_preprocessing", {"same_internal_tensors": True}),
])
def test_report_rejects_tampered_protocol_or_photo_count(study, monkeypatch, field, value):
    run(study, monkeypatch)
    folder = study["root"] / "runs" / "paired-001"
    config = json.loads((folder / "run-config.json").read_text())
    config[field] = value
    write(folder / "run-config.json", config)
    with pytest.raises(comparison.ComparisonError):
        comparison.comparison_report(study["workspace"], "pilot-001", "paired-001", now=NOW)
    assert not (folder / "summary.json").exists()


def test_report_rejects_a_result_without_matching_durable_input_hash(study, monkeypatch):
    run(study, monkeypatch)
    folder = study["root"] / "runs" / "paired-001"
    row = json.loads((folder / "results.jsonl").read_text())
    row["shared_jpeg_sha256"] = "0" * 64
    (folder / "results.jsonl").write_text(json.dumps(row) + "\n")
    with pytest.raises(comparison.ComparisonError, match="durable external attempt"):
        comparison.comparison_report(study["workspace"], "pilot-001", "paired-001", now=NOW)


def test_purge_during_api_cancels_persistence_and_additional_photo_claims(study, monkeypatch):
    second = {**study["photo"], "photo_id": "e-2222222222222222", "file": "images/e-2222222222222222.jpg"}
    raw = image_bytes((321, 256))
    second["sha256"] = hashlib.sha256(raw).hexdigest()
    (study["root"] / second["file"]).write_bytes(raw)
    study["manifest"]["photos"].append(second)
    write(study["root"] / "manifest.json", study["manifest"])
    monkeypatch.setenv("OPENAI_API_KEY", "sk-" + "x" * 20)
    inputs, predictor, api = adapters(study, mutate=lambda: comparison.comparison_purge(
        study["workspace"], "pilot-001", all_results=True, now=NOW))
    with pytest.raises(comparison.ComparisonError, match="purged"):
        comparison.comparison_run(study["workspace"], "pilot-001", "paired-001", now=NOW,
            send_to_openai=True, predictor_factory=predictor, api_factory=api)
    folder = study["root"] / "runs" / "paired-001"
    assert len(inputs["api"]) == 1 and len(inputs["local"]) == 1
    assert (folder / "purged.json").exists()
    assert not any((folder / name).exists() for name in ("results.jsonl", "attempts.jsonl", "summary.json", "summary.md", "completed.json"))
    with pytest.raises(comparison.ComparisonError, match="purged"):
        comparison._append(folder / "attempts.jsonl", {"event": "cannot resurrect"})


def test_purge_during_report_render_cancels_all_summary_writes(study, monkeypatch):
    from senmiva_training import vision_review
    run(study, monkeypatch)
    original = vision_review.render_report
    def render(report):
        comparison.comparison_purge(study["workspace"], "pilot-001", all_results=True, now=NOW)
        return original(report)
    monkeypatch.setattr(vision_review, "render_report", render)
    with pytest.raises(comparison.ComparisonError, match="purged"):
        comparison.comparison_report(study["workspace"], "pilot-001", "paired-001", now=NOW)
    folder = study["root"] / "runs" / "paired-001"
    assert not any((folder / name).exists() for name in ("results.jsonl", "attempts.jsonl", "summary.json", "summary.md"))


def test_purge_tombstone_is_durable_before_generated_files_are_unlinked(study, monkeypatch):
    run(study, monkeypatch)
    original = Path.unlink
    def unlink(path, *args, **kwargs):
        if path.name in ("results.jsonl", "attempts.jsonl", "summary.json", "summary.md"):
            assert (path.parent / "purged.json").is_file()
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, "unlink", unlink)
    comparison.comparison_purge(study["workspace"], "pilot-001", all_results=True, now=NOW)


def test_native_run_lock_is_shared_across_processes_and_released_on_exit(tmp_path):
    folder = tmp_path / "private-run"
    folder.mkdir()
    marker = folder / "child-holds-lock"
    code = "import sys,time; from pathlib import Path; from senmiva_training.vision_comparison import _run_guard; root=Path(sys.argv[1]);\nwith _run_guard(root):\n (root/'child-holds-lock').write_text('held'); time.sleep(0.3)\n"
    process = subprocess.Popen([sys.executable, "-c", code, str(folder)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")})
    try:
        deadline = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert marker.exists()
        started = time.monotonic()
        with comparison._run_guard(folder):
            waited = time.monotonic() - started
        assert waited >= 0.1
        assert process.wait(timeout=5) == 0
        # Persistent lockfile does not become a stale lock after process exit.
        with comparison._run_guard(folder):
            pass
    finally:
        if process.poll() is None:
            process.terminate()
        process.communicate(timeout=5)
