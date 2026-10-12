"""Explicit research-only paired comparison. No kiosk, training, or discovery.

Import/check/dry-run never imports Pillow/Torch, loads a key/model or uses network.
Only an explicitly send-enabled run can process operator-listed consented photos.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import time
from typing import Any, Callable
import warnings

from .workspace import private_output


NOTICE_VERSION = "2026-10-external-face-evaluation-v1"
TASK = "consented_paired_vision_comparison"
MAX_PHOTOS = 100
MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_DOCUMENT_BYTES = 1024 * 1024
MAX_MANIFEST_BYTES = 32 * 1024 * 1024
SHARED_PREPROCESSING = {
    "version": "rgb-jpeg1536-v1", "exif_transpose": True,
    "strip_all_metadata": True, "color_mode": "RGB", "max_edge": 1536,
    "min_edge": 224, "max_decoded_pixels": 25_000_000,
    "resize": "Pillow LANCZOS aspect-preserving, no upscale",
    "jpeg_quality": 90, "jpeg_subsampling": 0, "progressive": False,
    "same_encoded_bytes_both_providers": True,
    "same_internal_tensors": False,
}
LOCAL_PREPROCESSING = {
    "version": "saved-convnext-evaluation-preprocessing",
    "resize_short_edge": 236, "center_crop": [224, 224],
    "warning": "The local model internally center-crops; hosted vision internal resizing differs. Identical shared JPEG bytes do not imply identical tensors.",
}
_MANIFEST_KEYS = {"schema_version", "evaluation_id", "notice_version", "created_at", "retention_expires_at", "photos"}
_PHOTO_KEYS = {"photo_id", "participant_group", "file", "sha256", "consent_id"}
_CONSENT_KEYS = {"consent_id", "participant_group", "notice_version", "adult", "external_processing", "local_results_storage", "independent_from_training", "not_aihub_or_other_licensed_source", "single_subject_images", "accepted_at", "expires_at", "revoked_at"}
_ATTESTATIONS = ("adult", "external_processing", "local_results_storage", "independent_from_training", "not_aihub_or_other_licensed_source", "single_subject_images")
_OPAQUE = re.compile(r"[epc]-[0-9a-f]{16}")
_HASH = re.compile(r"[0-9a-f]{64}")
_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
_IMAGE_FILE = re.compile(r"images/[e]-[0-9a-f]{16}\.(jpg|jpeg|png|webp)")


class ComparisonError(ValueError):
    """Authored messages contain no filenames, identifiers, keys or HTTP bodies."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _date(value: Any) -> datetime:
    try:
        if not isinstance(value, str) or len(value) > 40:
            raise ValueError()
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None or result.utcoffset() != timedelta(0):
            raise ValueError()
        return result.astimezone(timezone.utc)
    except Exception:
        raise ComparisonError("Use explicit UTC ISO timestamps in evaluation records.") from None


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ComparisonError("Duplicate JSON fields are not permitted.")
        result[key] = value
    return result


def _json(path: Path, limit: int = MAX_DOCUMENT_BYTES) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise ComparisonError("A required bounded evaluation record is unavailable.")
    try:
        result = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_unique_object,
                            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except Exception:
        raise ComparisonError("An evaluation JSON record is invalid.") from None
    if type(result) is not dict:
        raise ComparisonError("An evaluation record must be a JSON object.")
    return result


def _digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _linked(path: Path) -> bool:
    return path.is_symlink() or getattr(path, "is_junction", lambda: False)()


def _generated_path(path: Path) -> None:
    if _linked(path) or path.parent.resolve() != path.parent.absolute():
        raise ComparisonError("Generated evaluation records must remain in their original private folder.")


def _assert_run_active(run: Path) -> None:
    tombstone = run / "purged.json"
    if tombstone.exists() or _linked(tombstone):
        raise ComparisonError("This comparison run was purged. No further calls or output writes are permitted.")


@contextmanager
def _run_guard(run: Path, *, allow_purged: bool = False):
    """Short cross-process native lock. Never hold it during model/API work.

    The persistent lock file is not a lock claim: OS handle ownership is the
    claim and process death releases it. Never unlink it during purge.
    """
    lock_path = run / ".run.lock"
    _generated_path(lock_path)
    with lock_path.open("a+b") as lock:
        lock.seek(0, os.SEEK_END)
        if lock.tell() == 0:
            lock.write(b"\0")
            lock.flush()
            os.fsync(lock.fileno())
        lock.seek(0)
        locked = False
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            locked = True
            if not allow_purged:
                _assert_run_active(run)
            yield
        except OSError:
            raise ComparisonError("The private comparison run is busy or its lock is unavailable.") from None
        finally:
            if locked:
                lock.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _file_digest(path: Path) -> str:
    if not path.is_file() or path.stat().st_size > 512 * 1024 * 1024:
        raise ComparisonError("The bounded existing local checkpoint is unavailable.")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_new(path: Path, payload: dict[str, Any]) -> None:
    _generated_path(path)
    if path.name != "purged.json":
        _assert_run_active(path.parent)
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(payload, ensure_ascii=True, allow_nan=False, indent=2) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def _append_unlocked(path: Path, payload: dict[str, Any]) -> None:
    _generated_path(path)
    _assert_run_active(path.parent)
    with path.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(payload, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def _append(path: Path, payload: dict[str, Any]) -> None:
    with _run_guard(path.parent):
        _append_unlocked(path, payload)


def _name(value: str) -> str:
    if type(value) is not str or not _NAME.fullmatch(value):
        raise ComparisonError("Use a new short evaluation or run name with letters, digits, hyphens or underscores.")
    return value


def evaluation_root(workspace: Path, name: str) -> Path:
    workspace = private_output(Path(workspace))
    root = workspace / "comparisons" / _name(name)
    # Resolve before IO, including existing Windows reparse/symlink parents.
    if not root.resolve().is_relative_to(workspace) or _linked(root):
        raise ComparisonError("Evaluation paths must stay inside the private workspace.")
    return private_output(root)


def comparison_init(workspace: Path, name: str, *, now: datetime | None = None) -> dict[str, Any]:
    root = evaluation_root(workspace, name)
    now = now or _now()
    root.mkdir(parents=True, exist_ok=False)
    (root / "images").mkdir()
    _write_new(root / "manifest.json", {
        "schema_version": 1, "evaluation_id": name, "notice_version": NOTICE_VERSION,
        "created_at": _iso(now), "retention_expires_at": _iso(now + timedelta(days=14)), "photos": [],
    })
    _write_new(root / "consents.json", {"schema_version": 1, "notice_version": NOTICE_VERSION, "participants": []})
    _write_new(root / "consent-template.json", {
        "consent_id": "c-0000000000000000", "participant_group": "p-0000000000000000",
        "notice_version": NOTICE_VERSION,
        **{key: False for key in _ATTESTATIONS},
        "accepted_at": None, "expires_at": None, "revoked_at": None,
    })
    (root / "NOTICE.txt").write_text(
        "RESEARCH ONLY. No photos are provided or discovered automatically.\n"
        "Use new adult evaluation volunteers with specific documented informed consent.\n"
        "Face pictures are identifying personal data, even with opaque IDs.\n"
        "This separate notice authorizes transmitting metadata-stripped face pictures to OpenAI, not the kiosk's ingredient-only explanation consent.\n"
        "Default OpenAI API abuse-monitoring retention may be up to 30 days; local deletion cannot guarantee deletion of provider-held records.\n"
        "Get separate consent for private local model-result storage until the recorded expiry. Revocation prevents future calls; run comparison-purge to remove local results.\n"
        "Do not list AI-Hub images, licensed source datasets, customer kiosk photos, minors or training/validation photos. Participant separation is operator-attested, not verified from identities.\n"
        "Each image must contain only the consenting adult: no bystanders, collages or identifying text. This is a required operator attestation, not automatic face-count or identity verification.\n"
        "Manually place only consented evaluation originals in images/ and fill exact SHA256, opaque e-/p-/c- 16-hex IDs and UTC records. No names, email or medical history.\n"
        "Eight ConvNeXt codes have unverified meanings and are not mapped to hosted vision appearance labels. Neither output is a clinical measurement, diagnosis or ground truth.\n"
        "comparison-check and comparison-run without --send-to-openai use no models, keys or network. An explicit send-enabled run makes at most one request per listed photo; no automatic retries or run overwrites.\n",
        encoding="utf-8",
    )
    return {"status": "needs_photos", "photo_count": 0, "evaluation_id": name,
            "notice_version": NOTICE_VERSION, "message": "Empty private evaluation templates are ready. No photos were read and no API request was made."}


def _source_exclusions(workspace: Path) -> tuple[list[Path], set[str], dict[str, str]]:
    roots = [workspace / "datasets", workspace / "manifests", workspace / "runs"]
    registry = workspace / "dataset.json"
    if registry.exists():
        record = _json(registry)
        if not isinstance(record.get("root_path"), str) or not Path(record["root_path"]).is_absolute():
            raise ComparisonError("The registered source exclusion record is invalid.")
        roots.append(Path(record["root_path"]).resolve())
    hashes: set[str] = set()
    witnesses = {}
    manifest_root = workspace / "manifests"
    if manifest_root.exists():
        if manifest_root.is_symlink():
            raise ComparisonError("Training exclusion records must not be symbolic links.")
        folders = list(manifest_root.iterdir())
        if len(folders) > 100:
            raise ComparisonError("Too many training exclusion folders; review the research workspace.")
        for folder in folders:
            if not folder.is_dir():
                continue
            if folder.is_symlink() or not folder.resolve().is_relative_to(workspace):
                raise ComparisonError("Training exclusion records must stay in the private workspace.")
            for split in ("train", "validation"):
                path = folder / f"{split}.jsonl"
                if not path.exists():
                    continue
                if path.is_symlink() or path.stat().st_size > MAX_MANIFEST_BYTES:
                    raise ComparisonError("A training exclusion record is unavailable or too large.")
                raw = path.read_bytes()
                witnesses[f"{folder.name}/{split}"] = _digest(raw)
                for line in raw.splitlines():
                    try:
                        row = json.loads(line, object_pairs_hook=_unique_object)
                    except Exception:
                        raise ComparisonError("A training exclusion manifest is invalid.") from None
                    if type(row) is not dict:
                        raise ComparisonError("A training exclusion manifest is invalid.")
                    if "image_sha256" in row:
                        value = row["image_sha256"]
                        if type(value) is not str or not _HASH.fullmatch(value):
                            raise ComparisonError("A training image exclusion hash is invalid.")
                        hashes.add(value)
    return [root.resolve() for root in roots], hashes, witnesses


def _load_records(workspace: Path, name: str, now: datetime) -> tuple[Path, dict, dict, dict[str, dict]]:
    root = evaluation_root(workspace, name)
    manifest = _json(root / "manifest.json")
    consents = _json(root / "consents.json")
    if (set(manifest) != _MANIFEST_KEYS or type(manifest["schema_version"]) is not int
        or manifest["schema_version"] != 1 or manifest["evaluation_id"] != name
        or manifest["notice_version"] != NOTICE_VERSION
        or type(manifest["photos"]) is not list or len(manifest["photos"]) > MAX_PHOTOS):
        raise ComparisonError("The evaluation manifest does not match the fixed schema.")
    created, expiry = _date(manifest["created_at"]), _date(manifest["retention_expires_at"])
    if not created <= now < expiry or expiry > created + timedelta(days=30):
        raise ComparisonError("The evaluation retention period is invalid or expired.")
    if (set(consents) != {"schema_version", "notice_version", "participants"}
        or type(consents["schema_version"]) is not int or consents["schema_version"] != 1
        or consents["notice_version"] != NOTICE_VERSION
        or type(consents["participants"]) is not list or len(consents["participants"]) > MAX_PHOTOS):
        raise ComparisonError("The external-photo consent record does not match the fixed schema.")
    indexed = {}
    groups = set()
    for consent in consents["participants"]:
        if (type(consent) is not dict or set(consent) != _CONSENT_KEYS
            or any(type(consent.get(key)) is not str or not _OPAQUE.fullmatch(consent[key])
                   for key in ("consent_id", "participant_group"))
            or not consent["consent_id"].startswith("c-") or not consent["participant_group"].startswith("p-")
            or consent["consent_id"] in indexed or consent["participant_group"] in groups):
            raise ComparisonError("Use unique opaque participant and consent IDs in the fixed schema.")
        indexed[consent["consent_id"]] = consent
        groups.add(consent["participant_group"])
    ids, paths, hashes = set(), set(), set()
    for photo in manifest["photos"]:
        if (type(photo) is not dict or set(photo) != _PHOTO_KEYS
            or type(photo["photo_id"]) is not str or not _OPAQUE.fullmatch(photo["photo_id"])
            or not photo["photo_id"].startswith("e-")
            or type(photo["file"]) is not str or not _IMAGE_FILE.fullmatch(photo["file"])
            or PurePosixPath(photo["file"]).stem != photo["photo_id"]
            or type(photo["sha256"]) is not str or not _HASH.fullmatch(photo["sha256"])
            or type(photo["consent_id"]) is not str or not _OPAQUE.fullmatch(photo["consent_id"])
            or photo["photo_id"] in ids or photo["file"] in paths or photo["sha256"] in hashes):
            raise ComparisonError("Use unique opaque photo IDs, exact relative image paths and SHA256 hashes.")
        consent = indexed.get(photo["consent_id"])
        if (consent is None or photo["participant_group"] != consent["participant_group"]
            or consent["notice_version"] != NOTICE_VERSION
            or any(consent[key] is not True for key in _ATTESTATIONS)
            or consent["revoked_at"] is not None):
            raise ComparisonError("Every photo needs current adult, external-processing, local-storage and independent-source consent.")
        accepted, consent_expiry = _date(consent["accepted_at"]), _date(consent["expires_at"])
        if not accepted <= now < consent_expiry or expiry > consent_expiry or consent_expiry > accepted + timedelta(days=30):
            raise ComparisonError("A required photo consent is expired or shorter than local result retention.")
        ids.add(photo["photo_id"]); paths.add(photo["file"]); hashes.add(photo["sha256"])
    if len(indexed) != len({photo["consent_id"] for photo in manifest["photos"]}):
        raise ComparisonError("Keep only consent records referenced by listed evaluation photos.")
    return root, manifest, consents, indexed


def _photo_bytes(root: Path, photo: dict, excluded_roots: list[Path], known_hashes: set[str]) -> bytes:
    target = root / photo["file"]
    resolved = target.resolve()
    image_root = root / "images"
    if (_linked(image_root) or _linked(target) or not image_root.resolve().is_relative_to(root.resolve())
        or not resolved.is_relative_to(image_root.resolve())
        or any(resolved == excluded or resolved.is_relative_to(excluded) for excluded in excluded_roots)
        or photo["sha256"] in known_hashes or not target.is_file()
        or not 1 <= target.stat().st_size <= MAX_IMAGE_BYTES):
        raise ComparisonError("A listed evaluation image is missing, outside its private folder, too large or overlaps training/source data.")
    raw = target.read_bytes()
    if not raw or len(raw) > MAX_IMAGE_BYTES or _digest(raw) != photo["sha256"]:
        raise ComparisonError("A listed evaluation image changed or does not match its SHA256.")
    return raw


def _check_current_records(workspace: Path, name: str, expected: dict, now: datetime | None) -> None:
    """Short consent/roster check inside a run guard; no image/model/network IO."""
    root, _, _, _ = _load_records(workspace, name, now or _now())
    if (_digest((root / "manifest.json").read_bytes()) != expected["manifest_sha256"]
        or _digest((root / "consents.json").read_bytes()) != expected["consents_sha256"]):
        raise ComparisonError("Current evaluation consent or roster changed before persistence.")


def comparison_check(workspace: Path, name: str, *, now: datetime | None = None) -> dict[str, Any]:
    """No decoding/models/key/network; read only explicitly listed photo bytes."""
    workspace = private_output(Path(workspace))
    now = now or _now()
    root, manifest, consents, _ = _load_records(workspace, name, now)
    count = len(manifest["photos"])
    witnesses = {}
    if count:
        excluded, known_hashes, witnesses = _source_exclusions(workspace)
        for photo in manifest["photos"]:
            _photo_bytes(root, photo, excluded, known_hashes)
    return {
        "status": "ready" if count else "needs_photos", "photo_count": count,
        "participant_count": len(consents["participants"]), "notice_version": NOTICE_VERSION,
        "manifest_sha256": _digest((root / "manifest.json").read_bytes()),
        "consents_sha256": _digest((root / "consents.json").read_bytes()),
        "training_manifest_fingerprints": witnesses,
        "exact_training_hash_exclusion": bool(count), "participant_separation": "operator-attested-only",
        "models_loaded": False, "api_requests": 0, "raw_photos_written": False,
        "message": "Validation completed without models, credentials or network." if count else "No evaluation photos are listed. Add separately consented independent adult photos before running a comparison.",
    }


def canonical_jpeg(raw: bytes) -> bytes:
    """Decode only an already consent-validated input; do not persist any pixels."""
    from PIL import Image, ImageOps
    try:
        if type(raw) is not bytes or not 1 <= len(raw) <= MAX_IMAGE_BYTES:
            raise ValueError()
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                if (image.format not in ("JPEG", "PNG", "WEBP") or getattr(image, "n_frames", 1) != 1
                    or getattr(image, "is_animated", False) or min(image.size) < 224
                    or image.width * image.height > 25_000_000):
                    raise ValueError()
                image.verify()
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
                oriented = ImageOps.exif_transpose(image)
                rgb = oriented.convert("RGB")
                try:
                    rgb.thumbnail((1536, 1536), Image.Resampling.LANCZOS)
                    if min(rgb.size) < 224:
                        raise ValueError()
                    # A fresh image from pixels cannot inherit EXIF, ICC or comments.
                    with Image.frombytes("RGB", rgb.size, rgb.tobytes()) as clean:
                        output = io.BytesIO()
                        clean.save(output, format="JPEG", quality=90, subsampling=0, progressive=False, optimize=False)
                        result = output.getvalue()
                finally:
                    rgb.close()
                    if oriented is not image:
                        oriented.close()
        if len(result) > 4 * 1024 * 1024:
            raise ValueError()
        return result
    except Exception:
        raise ComparisonError("An evaluation image cannot be converted to a bounded metadata-free RGB JPEG.") from None


def _api_key(env_file: Path | None) -> str:
    if env_file is None:
        key = os.environ.get("OPENAI_API_KEY", "")
    else:
        path = Path(env_file).expanduser().resolve()
        if not path.name.startswith(".env") or path.name == ".env.example" or path.stat().st_size > 64 * 1024:
            raise ComparisonError("Use an explicitly selected private local .env file for the API key.")
        key = ""
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            if line.strip().startswith("OPENAI_API_KEY="):
                if key:
                    raise ComparisonError("The selected local key configuration is ambiguous.")
                key = line.strip().split("=", 1)[1].strip().strip("\"'")
    if not re.fullmatch(r"sk-[A-Za-z0-9_-]{16,500}", key):
        raise ComparisonError("A valid server-side OpenAI API key is required for an explicit external run.")
    return key


def comparison_run(
    workspace: Path, name: str, comparison_run: str, *, manifest: str = "skin-all-001",
    model_run: str = "skin-all-head-001", checkpoint: str = "best", device: str = "cpu",
    send_to_openai: bool = False, openai_env_file: Path | None = None, max_api_calls: int = 20,
    now: datetime | None = None, predictor_factory: Callable | None = None,
    api_factory: Callable | None = None,
) -> dict[str, Any]:
    workspace = private_output(Path(workspace))
    _name(comparison_run); _name(manifest); _name(model_run)
    if checkpoint not in ("best", "last") or device not in ("auto", "cpu", "cuda") or type(send_to_openai) is not bool:
        raise ComparisonError("Choose a supported existing checkpoint and device.")
    if type(max_api_calls) is not int or not 1 <= max_api_calls <= MAX_PHOTOS:
        raise ComparisonError("Choose an explicit API-call budget between 1 and 100.")
    check = comparison_check(workspace, name, now=now)
    if not send_to_openai:
        return {**check, "dry_run": True, "api_call_budget": max_api_calls}
    if not check["photo_count"]:
        raise ComparisonError("No evaluation photos are listed. Prepare separately consented photos first.")
    if check["photo_count"] > max_api_calls:
        raise ComparisonError("The listed photos exceed the explicit API-call budget.")
    root = evaluation_root(workspace, name)
    run_root = root / "runs" / comparison_run
    if (run_root.exists() or _linked(run_root) or _linked(root / "runs")
        or not run_root.resolve().is_relative_to(root / "runs")
        or not run_root.resolve().is_relative_to(root)):
        raise ComparisonError("Comparison runs are immutable and cannot be retried or overwritten. Review the existing journal.")
    from . import vision_api
    if predictor_factory is None:
        from .photo_inference import PhotoPredictor
        predictor_factory = PhotoPredictor
    api_factory = api_factory or vision_api.VisionApiClient
    # Read credentials only after explicit send, consent, budget and source checks.
    key = _api_key(openai_env_file)
    checkpoint_path = workspace / "runs" / model_run / f"checkpoint-{checkpoint}.pt"
    if (checkpoint_path.is_symlink() or not checkpoint_path.is_file()
        or not checkpoint_path.resolve().is_relative_to((workspace / "runs").resolve())
        or _linked(workspace / "runs" / model_run)
        or _linked(workspace / "runs")
        or not (workspace / "runs").resolve().is_relative_to(workspace)):
        raise ComparisonError("The existing local checkpoint is unavailable.")
    checkpoint_hash = _file_digest(checkpoint_path)
    started = time.perf_counter()
    predictor = predictor_factory(workspace / "manifests" / manifest, workspace / "runs" / model_run,
                                  checkpoint=checkpoint, device=device)
    model_load_ms = round((time.perf_counter() - started) * 1000)
    if _file_digest(checkpoint_path) != checkpoint_hash:
        raise ComparisonError("The existing checkpoint changed during loading.")
    api = api_factory(key)
    del key
    current = comparison_check(workspace, name, now=now)
    if current != check:
        raise ComparisonError("Evaluation records changed before execution. Check the current consent again.")
    run_root.mkdir(parents=True, exist_ok=False)
    run_now = now or _now()
    _, records, _, _ = _load_records(workspace, name, run_now)
    config = {
        "schema_version": 1, "task": TASK, "evaluation_id": name, "run_id": comparison_run,
        "created_at": _iso(run_now), "retention_expires_at": records["retention_expires_at"],
        "notice_version": NOTICE_VERSION, "manifest_sha256": check["manifest_sha256"], "consents_sha256": check["consents_sha256"],
        "local_model": {"model_run": model_run, "manifest": manifest, "checkpoint": checkpoint,
                        "checkpoint_sha256": checkpoint_hash, "device": device, "internal_preprocessing": LOCAL_PREPROCESSING},
        "openai": {"model": vision_api.PINNED_MODEL, "prompt_version": vision_api.PROMPT_VERSION,
                   "prompt_sha256": vision_api.PROMPT_SHA256},
        "shared_preprocessing": SHARED_PREPROCESSING, "api_call_budget": max_api_calls,
        "photo_count": check["photo_count"], "model_load_ms": model_load_ms,
        "training_manifest_fingerprints": check["training_manifest_fingerprints"],
        "experimental": True, "code_mapping_verified": False,
    }
    with _run_guard(run_root):
        _write_new(run_root / "run-config.json", config)
    attempted = completed = 0
    for photo in records["photos"]:
        with _run_guard(run_root):
            pass
        current = comparison_check(workspace, name, now=now)
        if current != check:
            raise ComparisonError("Evaluation records changed. No further external attempts are permitted.")
        excluded, hashes, _ = _source_exclusions(workspace)
        payload = canonical_jpeg(_photo_bytes(root, photo, excluded, hashes))
        shared_hash = _digest(payload)
        local_start = time.perf_counter()
        try:
            prediction = predictor.predict_image(payload)
            local = {"status": "completed", "latency_ms": round((time.perf_counter() - local_start) * 1000), "heads": prediction["heads"]}
        except Exception:
            local = {"status": "unavailable", "latency_ms": round((time.perf_counter() - local_start) * 1000), "heads": []}
        # Recheck consent/hash immediately before the durable external claim.
        if comparison_check(workspace, name, now=now) != check:
            del payload
            raise ComparisonError("Evaluation records changed. No further external attempts are permitted.")
        event = {"photo_id": photo["photo_id"], "participant_group": photo["participant_group"],
                 "at": _iso(now or _now()), "shared_jpeg_sha256": shared_hash}
        with _run_guard(run_root):
            _check_current_records(workspace, name, check, now)
            _append_unlocked(run_root / "attempts.jsonl", {**event, "event": "external_attempt_claimed"})
        attempted += 1
        _assert_run_active(run_root)
        external_start = time.perf_counter()
        try:
            external = api.analyze(payload).to_dict()
        except Exception:
            external = {"status": "unavailable", "model": vision_api.PINNED_MODEL, "prompt_version": vision_api.PROMPT_VERSION,
                        "observations": None, "usage": None,
                        "latency_ms": round((time.perf_counter() - external_start) * 1000),
                        "failure_kind": "transport_error"}
        finally:
            del payload
        # A participant may revoke during the request. Do not persist outputs.
        if comparison_check(workspace, name, now=now) != check:
            raise ComparisonError("Consent or evaluation records changed during processing. Purge the private run before further work.")
        status = external.get("status")
        if (status not in ("completed", "refused", "unavailable")
            or set(external) != {"status", "model", "prompt_version", "observations", "usage", "latency_ms", "failure_kind"}
            or external["model"] != vision_api.PINNED_MODEL or external["prompt_version"] != vision_api.PROMPT_VERSION):
            raise ComparisonError("The external adapter returned an invalid safe result.")
        with _run_guard(run_root):
            _check_current_records(workspace, name, check, now)
            _append_unlocked(run_root / "results.jsonl", {
                "schema_version": 1, "photo_id": photo["photo_id"], "participant_group": photo["participant_group"],
                "shared_jpeg_sha256": shared_hash, "processed_at": _iso(now or _now()), "local": local, "openai": external,
            })
            _append_unlocked(run_root / "attempts.jsonl", {**event, "at": _iso(now or _now()), "event": f"external_{status}"})
        completed += status == "completed"
    with _run_guard(run_root):
        _check_current_records(workspace, name, check, now)
        _write_new(run_root / "completed.json", {"schema_version": 1, "completed_at": _iso(now or _now()), "attempted": attempted})
    return {"status": "completed", "dry_run": False, "photo_count": check["photo_count"],
            "api_requests": attempted, "api_completed": completed, "raw_photos_written": False,
            "accuracy_comparison_available": False, "message": "Paired research outputs were saved privately. Source-code meanings are unverified; no cross-model accuracy was calculated."}


def comparison_purge(workspace: Path, name: str, *, all_results: bool = False, now: datetime | None = None) -> dict[str, Any]:
    """Remove only generated individual result/journal files; preserve run tombstones."""
    root = evaluation_root(workspace, name)
    now = now or _now()
    if type(all_results) is not bool:
        raise ComparisonError("Use an explicit boolean all-results deletion choice.")
    revoked_or_expired = all_results
    if not all_results:
        consents = _json(root / "consents.json")
        if type(consents.get("participants")) is not list:
            raise ComparisonError("Consent records are unavailable. Explicit --all-results removes generated outputs without requiring them.")
        revoked_or_expired = any(
            type(consent) is dict and (consent.get("revoked_at") is not None or _date(consent.get("expires_at")) <= now)
            for consent in consents["participants"]
        )
    runs_root = root / "runs"
    if _linked(runs_root) or not runs_root.resolve().is_relative_to(root):
        raise ComparisonError("The private comparison result folder is invalid.")
    purged = 0
    if runs_root.exists():
        for run in runs_root.iterdir():
            if not run.is_dir() or _linked(run) or not run.resolve().is_relative_to(runs_root):
                raise ComparisonError("A private comparison result folder is invalid.")
            with _run_guard(run, allow_purged=True):
                config_path = run / "run-config.json"
                orphan = not config_path.exists()
                if orphan and not all_results and any((run / filename).exists() for filename in ("results.jsonl", "attempts.jsonl", "summary.json", "summary.md")):
                    # A malformed partial run cannot block cleanup of other runs.
                    continue
                config = {} if orphan or all_results else _json(config_path)
                if not orphan and not revoked_or_expired and _date(config.get("retention_expires_at")) > now:
                    continue
                # Cancellation is durable before deletion. A crash during unlink
                # cannot allow a later producer/report to resurrect these files.
                if not (run / "purged.json").exists():
                    _write_new(run / "purged.json", {"schema_version": 1, "purged_at": _iso(now), "reason": "operator_all_results" if all_results else "consent_revocation_or_retention_expiry"})
                    purged += 1
                for filename in ("results.jsonl", "attempts.jsonl", "summary.json", "summary.md"):
                    target = run / filename
                    if _linked(target) or not target.resolve().is_relative_to(run):
                        raise ComparisonError("A private generated result path is invalid.")
                    target.unlink(missing_ok=True)
    return {"status": "completed", "purged_runs": purged, "original_photos_deleted": False}


def _json_lines(path: Path, *, optional: bool = False) -> list[dict[str, Any]]:
    if optional and not path.exists():
        return []
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 4 * MAX_DOCUMENT_BYTES:
        raise ComparisonError("A bounded private result record is unavailable.")
    try:
        rows = [json.loads(line, object_pairs_hook=_unique_object,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                for line in path.read_text(encoding="utf-8").splitlines()]
    except Exception:
        raise ComparisonError("A private result record is invalid or incomplete.") from None
    if len(rows) > MAX_PHOTOS * 3 or any(type(row) is not dict for row in rows):
        raise ComparisonError("A private result record exceeds its schema bounds.")
    return rows


def comparison_report(workspace: Path, name: str, run_id: str, *, now: datetime | None = None) -> dict[str, Any]:
    from .vision_review import build_report, render_report
    from . import vision_api
    root = evaluation_root(workspace, name)
    run = root / "runs" / _name(run_id)
    if (_linked(run) or _linked(root / "runs") or not run.resolve().is_relative_to(root)
        or (run / "purged.json").exists()):
        raise ComparisonError("This private comparison run is unavailable or has been purged.")
    if (run / "summary.json").exists() or (run / "summary.md").exists():
        raise ComparisonError("A comparison report already exists and will not be overwritten.")
    check = comparison_check(workspace, name, now=now)
    config = _json(run / "run-config.json")
    local_config, remote_config = config.get("local_model"), config.get("openai")
    if (set(config) != {"schema_version", "task", "evaluation_id", "run_id", "created_at", "retention_expires_at", "notice_version", "manifest_sha256", "consents_sha256", "local_model", "openai", "shared_preprocessing", "api_call_budget", "photo_count", "model_load_ms", "training_manifest_fingerprints", "experimental", "code_mapping_verified"}
        or type(config.get("schema_version")) is not int or config["schema_version"] != 1 or config.get("task") != TASK
        or config.get("evaluation_id") != name or config.get("run_id") != run_id
        or config.get("notice_version") != NOTICE_VERSION
        or config.get("manifest_sha256") != check["manifest_sha256"]
        or config.get("consents_sha256") != check["consents_sha256"]
        or _date(config.get("retention_expires_at")) <= (now or _now())
        or config.get("shared_preprocessing") != SHARED_PREPROCESSING
        or type(config.get("photo_count")) is not int or config["photo_count"] != check["photo_count"]
        or type(local_config) is not dict
        or set(local_config) != {"model_run", "manifest", "checkpoint", "checkpoint_sha256", "device", "internal_preprocessing"}
        or local_config["internal_preprocessing"] != LOCAL_PREPROCESSING
        or local_config["checkpoint"] not in ("best", "last") or local_config["device"] not in ("cpu", "cuda", "auto")
        or type(local_config["checkpoint_sha256"]) is not str or not _HASH.fullmatch(local_config["checkpoint_sha256"])
        or remote_config != {"model": vision_api.PINNED_MODEL, "prompt_version": vision_api.PROMPT_VERSION, "prompt_sha256": vision_api.PROMPT_SHA256}
        or config.get("training_manifest_fingerprints") != check["training_manifest_fingerprints"]
        or config.get("experimental") is not True
        or config.get("code_mapping_verified") is not False):
        raise ComparisonError("Run configuration, consent or retention no longer matches the checked evaluation.")
    _name(local_config["model_run"]); _name(local_config["manifest"])
    rows = _json_lines(run / "results.jsonl", optional=True)
    attempts = _json_lines(run / "attempts.jsonl", optional=True)
    _, records, _, _ = _load_records(private_output(Path(workspace)), name, now or _now())
    allowed = {row["photo_id"]: row["participant_group"] for row in records["photos"]}
    seen = set()
    for row in rows:
        if (set(row) != {"schema_version", "photo_id", "participant_group", "shared_jpeg_sha256", "processed_at", "local", "openai"}
            or type(row["photo_id"]) is not str or row["photo_id"] not in allowed
            or row["participant_group"] != allowed[row["photo_id"]]
            or row["photo_id"] in seen or type(row["shared_jpeg_sha256"]) is not str
            or type(row["local"]) is not dict or type(row["openai"]) is not dict
            or not _HASH.fullmatch(row["shared_jpeg_sha256"])):
            raise ComparisonError("Saved paired rows do not match the opaque evaluation roster.")
        seen.add(row["photo_id"])
    claims, finished = {}, {}
    for event in attempts:
        if (set(event) != {"photo_id", "participant_group", "at", "shared_jpeg_sha256", "event"}
            or type(event["photo_id"]) is not str or event["photo_id"] not in allowed
            or event["participant_group"] != allowed[event["photo_id"]]
            or type(event["shared_jpeg_sha256"]) is not str or not _HASH.fullmatch(event["shared_jpeg_sha256"])
            or event["event"] not in ("external_attempt_claimed", "external_completed", "external_refused", "external_unavailable")):
            raise ComparisonError("A private attempt journal does not match the fixed schema.")
        _date(event["at"])
        if event["event"] == "external_attempt_claimed":
            if event["photo_id"] in claims:
                raise ComparisonError("A duplicate external attempt claim was found.")
            claims[event["photo_id"]] = event["shared_jpeg_sha256"]
        else:
            if event["photo_id"] not in claims or event["photo_id"] in finished:
                raise ComparisonError("A private attempt journal has inconsistent completion records.")
            if event["shared_jpeg_sha256"] != claims[event["photo_id"]]:
                raise ComparisonError("A private completion does not match its claimed input hash.")
            finished[event["photo_id"]] = event["event"].removeprefix("external_")
    for row in rows:
        if (row["photo_id"] not in claims or row["shared_jpeg_sha256"] != claims[row["photo_id"]]
            or (row["photo_id"] in finished and row["openai"].get("status") != finished[row["photo_id"]])):
            raise ComparisonError("A saved result does not match its durable external attempt.")
    report = build_report(config, rows)
    report["attempt_journal"] = {
        "claimed": len(claims), "finished": len(finished), "uncertain": len(set(claims) - set(finished)),
        "run_completed": (run / "completed.json").is_file(), "automatic_retry_permitted": False,
    }
    rendered = render_report(report)
    with _run_guard(run):
        # Recheck authority after aggregate work; purge may complete while the
        # renderer is running, including another process with still-valid consent.
        _check_current_records(private_output(Path(workspace)), name, check, now)
        _write_new(run / "summary.json", report)
        _generated_path(run / "summary.md")
        with (run / "summary.md").open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(rendered)
            stream.flush(); os.fsync(stream.fileno())
    return report
