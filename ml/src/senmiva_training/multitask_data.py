"""Private all-region preparation of eight observed source visual code targets.

CSV/JPEG pairing and exact-image curation retain publisher partitions. Neither
source record numbers, concern folders, questionnaires nor demographics become
labels or identity groups. Code meanings and image/label compatibility remain
unverified. This module reads extracted files only and never copies photographs.
"""

from __future__ import annotations

from collections import Counter, defaultdict
import csv
import hashlib
import hmac
import io
import json
from pathlib import Path
import re
import secrets
from typing import Any

from senmiva_training.data import _MAX_CSV_BYTES, _MAX_IMAGE_BYTES, _read_file
from senmiva_training.workspace import private_output


# Classes are opaque publisher codes. Tuple order is a classifier index, not a
# claim about clinical severity, ordinal distance or an abbreviation's meaning.
TARGETS: dict[str, tuple[str, ...]] = {
    "sensitivity": ("NS", "S"),
    "pigmentation": ("P0", "P1", "P2"),
    "wrinkles": ("W0", "W1", "W2"),
    "acne": ("NA", "A"),
    "pores": ("NVP", "VP"),
    "sagging": ("NSA", "SA"),
    "keratin": ("ND", "D"),
    "redness": ("NR", "R"),
}
TARGET_COLUMNS = {
    "sensitivity": "민감성 (육안 평가)",
    "pigmentation": "미백 (육안 평가)",
    "wrinkles": "주름 (육안 평가)",
    "acne": "여드름 (육안 평가)",
    "pores": "모공 (육안 평가)",
    "sagging": "피부 처짐 (육안 평가)",
    "keratin": "과각질 (육안 평가)",
    "redness": "붉어짐 (육안 평가)",
}
REGION_COLUMN = "이미지 부위 (상/중/하)"
REGIONS = ("상", "중", "하")
TASK = "all-region-source-visual-code-multitask-classification"
_PARTITIONS = ("training", "validation")
_FILES = {"training": "train.jsonl", "validation": "validation.jsonl"}
_ROW_KEYS = {
    "sample_id", "split", "image_path", "image_member", "image_sha256",
    "region", "labels", "grouping_verified",
}
_SCHEMA = {
    "schema_version": 1,
    "task": TASK,
    "row_fields": sorted(_ROW_KEYS),
    "target_schema": {target: list(classes) for target, classes in TARGETS.items()},
    "target_columns": TARGET_COLUMNS,
    "source_code_mapping": {target: {code: code for code in classes} for target, classes in TARGETS.items()},
    "missing_code_mapping": {"": None},
    "unknown_code_policy": "reject",
    "region_values": [*REGIONS, None],
    "region_missing_or_conflicting": None,
    "grouping_verified": False,
    "label_semantics_verified": False,
    "region_label_compatibility_verified": False,
}
_SCHEMA_DIGEST = hashlib.sha256(json.dumps(_SCHEMA, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _partition(path: Path, source: Path) -> str | None:
    observed = set()
    for part in path.relative_to(source).parts[:-1]:
        if part.startswith("TS_"):
            observed.add("training")
        elif part.startswith("VS_"):
            observed.add("validation")
    if len(observed) > 1:
        raise ValueError("Source ancestors specify conflicting publisher partitions.")
    return next(iter(observed), None)


def _parse_labels(payload: bytes) -> tuple[dict[str, str | None], str | None]:
    try:
        reader = csv.DictReader(io.StringIO(payload.decode("utf-8-sig")))
        fields = reader.fieldnames or []
        if len(fields) != len(set(fields)) or not {REGION_COLUMN, *TARGET_COLUMNS.values()}.issubset(fields):
            raise ValueError("Source CSV is missing the explicit visual-assessment schema.")
        records = list(reader)
    except (UnicodeError, csv.Error):
        raise ValueError("Source CSV must be valid UTF-8 CSV.") from None
    if len(records) != 1 or None in records[0] or any(value is None for value in records[0].values()):
        raise ValueError("Each source CSV must contain exactly one complete record.")
    row = records[0]
    labels: dict[str, str | None] = {}
    for target, classes in TARGETS.items():
        code = row[TARGET_COLUMNS[target]].strip()
        if code and code not in classes:
            # Never include an untrusted value (which might be personal text) in
            # an error or public aggregate report.
            raise ValueError(f"Source CSV contains an unsupported visual code for {target}.")
        labels[target] = code or None
    region = row[REGION_COLUMN].strip()
    if region and region not in REGIONS:
        raise ValueError("Source CSV contains an unsupported image region code.")
    return labels, region or None


def _write_json(path: Path, value: Any, *, lines: bool = False) -> None:
    # Exclusive creation plus a completion summary written last makes a failed
    # preparation unusable and prevents subsequent preparation from replacing it.
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        if lines:
            for row in value:
                stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
        else:
            json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
    path.chmod(0o600)


def _read_source(path: Path, maximum: int) -> bytes:
    try:
        return _read_file(path, maximum)
    except OSError:
        raise ValueError("An extracted source file is unavailable or unreadable.") from None


def _extraction_fingerprint(source: Path) -> str | None:
    """Reject incomplete managed extraction; plain extracted fixtures still work."""
    if (source / "incomplete.json").exists():
        raise ValueError("Dataset extraction is incomplete; preparation stopped.")
    index_path, summary_path = source / "extraction-index.json", source / "summary.json"
    if not index_path.exists() and not summary_path.exists():
        return None
    try:
        index = json.loads(index_path.read_text(encoding="utf-8"))
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        digest = summary.get("dataset_sha256") if isinstance(summary, dict) else None
        if (
            not isinstance(index, dict) or not isinstance(summary, dict)
            or index.get("complete") is not True or summary.get("complete") is not True
            or index.get("schema_version") != 1 or summary.get("schema_version") != 1
            or index.get("summary") != summary
            or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)
        ):
            raise ValueError("A complete, consistent extraction index and summary are required.")
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ValueError("A complete, consistent extraction index and summary are required.") from None
    return digest


def _counts(rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "retained_images": len(rows),
        "retained_region_counts": dict(Counter(row["region"] or "unknown" for row in rows)),
        "label_counts": {
            target: dict(Counter(row["labels"][target] for row in rows if row["labels"][target] is not None))
            for target in TARGETS
        },
        "labeled_images": {target: sum(row["labels"][target] is not None for row in rows) for target in TARGETS},
        "missing_labels": {target: sum(row["labels"][target] is None for row in rows) for target in TARGETS},
    }


def prepare_multitask(source: Path, output: Path, cross_split_policy: str = "exclude-all") -> dict[str, Any]:
    """Prepare immutable private all-target manifests from extracted CSV/JPEGs.

    Every matched photo is hashed before label filtering. Shared exact-image
    hashes are excluded from both publisher partitions by default. Within a
    partition, observed consistent labels combine across records; a target with
    conflicting observed codes stays missing. Blank values never become negative
    labels. All-missing images are excluded only after combination.
    """
    source, output = Path(source).resolve(), Path(output).resolve()
    if not source.is_dir():
        raise ValueError("The extracted source dataset directory does not exist.")
    extraction_fingerprint = _extraction_fingerprint(source)
    if cross_split_policy not in ("exclude-all", "reject"):
        raise ValueError("Cross-split policy must be reject or exclude-all.")
    output = private_output(output, source)
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError("Prepared directories are immutable; choose a new empty output directory.")

    pairs: dict[tuple[str, str], dict[str, Path]] = defaultdict(dict)
    for path in sorted(source.rglob("*"), key=lambda path: str(path).casefold()):
        if not path.is_file() or path.suffix.casefold() not in (".csv", ".jpg", ".jpeg"):
            continue
        partition = _partition(path, source)
        if partition is None:
            continue
        resolved = path.resolve()
        if not resolved.is_relative_to(source):
            raise ValueError("An extracted source file resolves outside the dataset directory.")
        kind = "csv" if path.suffix.casefold() == ".csv" else "image"
        key = (partition, str(path.with_suffix("")).casefold())
        if kind in pairs[key]:
            raise ValueError("Ambiguous extracted image/CSV pairing.")
        pairs[key][kind] = resolved

    groups: dict[str, dict[str, dict[str, Any]]] = {partition: {} for partition in _PARTITIONS}
    occurrences: dict[str, Counter[str]] = defaultdict(Counter)
    totals = {partition: Counter({
        "source_pairs": 0, "identical_source_pair_copies": 0, "exact_duplicate_source_images": 0,
    }) for partition in _PARTITIONS}
    raw_labels = {partition: {target: Counter() for target in TARGETS} for partition in _PARTITIONS}
    raw_regions = {partition: Counter() for partition in _PARTITIONS}
    copied_pairs: set[tuple[str, str, str]] = set()
    for (partition, _), pair in pairs.items():
        if set(pair) != {"csv", "image"}:
            raise ValueError("An extracted source image/CSV pair is incomplete.")
        csv_payload = _read_source(pair["csv"], _MAX_CSV_BYTES)
        labels, region = _parse_labels(csv_payload)
        digest = hashlib.sha256(_read_source(pair["image"], _MAX_IMAGE_BYTES)).hexdigest()
        totals[partition]["source_pairs"] += 1
        occurrences[digest][partition] += 1
        raw_regions[partition][region or "unknown"] += 1
        for target, code in labels.items():
            raw_labels[partition][target][code or "missing"] += 1
        copy_key = (partition, digest, hashlib.sha256(csv_payload).hexdigest())
        if copy_key in copied_pairs:
            totals[partition]["identical_source_pair_copies"] += 1
        copied_pairs.add(copy_key)
        group = groups[partition].get(digest)
        if group is None:
            group = {
                "image_path": str(pair["image"]), "regions": set(),
                "labels": {target: set() for target in TARGETS}, "source_pairs": 0,
            }
            groups[partition][digest] = group
        else:
            totals[partition]["exact_duplicate_source_images"] += 1
        group["source_pairs"] += 1
        if region is not None:
            group["regions"].add(region)
        for target, code in labels.items():
            if code is not None:
                group["labels"][target].add(code)

    cross_split_hashes = {digest for digest, splits in occurrences.items() if len(splits) > 1}
    if cross_split_hashes and cross_split_policy == "reject":
        raise ValueError("Exact image duplication crosses training and validation; preparation stopped.")

    salt = secrets.token_bytes(32)
    prepared: dict[str, list[dict[str, Any]]] = {partition: [] for partition in _PARTITIONS}
    conflict_counts = {partition: Counter() for partition in _PARTITIONS}
    for partition in _PARTITIONS:
        totals[partition]["unique_images_before_cross_split_exclusion"] = len(groups[partition])
        totals[partition]["excluded_cross_split_images"] = sum(digest in cross_split_hashes for digest in groups[partition])
        totals[partition]["excluded_cross_split_source_pairs"] = sum(occurrences[digest][partition] for digest in cross_split_hashes)
        totals[partition]["unique_images_after_cross_split_exclusion"] = len(groups[partition]) - totals[partition]["excluded_cross_split_images"]
        totals[partition]["excluded_all_missing_images"] = 0
        totals[partition]["region_conflict_images"] = 0
        for digest, group in groups[partition].items():
            if digest in cross_split_hashes:
                continue
            merged: dict[str, str | None] = {}
            for target, codes in group["labels"].items():
                if len(codes) > 1:
                    conflict_counts[partition][target] += 1
                merged[target] = next(iter(codes)) if len(codes) == 1 else None
            if len(group["regions"]) > 1:
                totals[partition]["region_conflict_images"] += 1
            if not any(code is not None for code in merged.values()):
                totals[partition]["excluded_all_missing_images"] += 1
                continue
            prepared[partition].append({
                "sample_id": hmac.new(salt, b"image:" + digest.encode("ascii"), hashlib.sha256).hexdigest(),
                "split": "train" if partition == "training" else "validation",
                "image_path": group["image_path"], "image_member": None,
                "image_sha256": digest,
                "region": next(iter(group["regions"])) if len(group["regions"]) == 1 else None,
                "labels": merged, "grouping_verified": False,
            })
        prepared[partition].sort(key=lambda row: row["sample_id"])
    if any(not rows for rows in prepared.values()):
        raise ValueError("Both publisher partitions must retain images with observed visual labels.")

    summary: dict[str, Any] = {
        "schema_version": 1, "task": TASK,
        "manifest_schema_sha256": _SCHEMA_DIGEST,
        "target_schema": {target: list(classes) for target, classes in TARGETS.items()},
        "target_columns": TARGET_COLUMNS,
        "grouping_verified": False,
        "grouping_basis": "salted exact-image identity; source person and capture grouping unverified",
        "label_semantics_verified": False,
        "region_label_compatibility_verified": False,
        "region_policy": "all observed source regions retained; missing or conflicting region metadata is unknown",
        "label_conflict_policy": "mask only conflicting targets after combining all observed labels",
        "missing_label_policy": "blank is missing; unsupported codes reject; no missing-to-negative conversion",
        "cross_split_policy": cross_split_policy,
        "cross_split_duplicate_hash_groups": len(cross_split_hashes),
        "image_hash_audit": "all matched source images before label filtering; no exact cross-partition duplicates retained",
        "validation_role": "publisher validation for model selection; no independent test set",
        "warnings": [
            "Source visual-code meanings and rater provenance remain unverified.",
            "Image-region and target-label compatibility remain unverified for every target and region.",
            "Exact-image separation does not establish person separation or eliminate near duplicates.",
            "Publisher validation is used for model selection, not independent product accuracy.",
        ],
        "partitions": {
            partition: {
                **dict(totals[partition]),
                "source_region_counts": dict(raw_regions[partition]),
                "source_label_counts": {target: dict(counts) for target, counts in raw_labels[partition].items()},
                "conflicting_target_images": {target: conflict_counts[partition][target] for target in TARGETS},
                **_counts(prepared[partition]),
            } for partition in _PARTITIONS
        },
    }
    if extraction_fingerprint is not None:
        summary["source_extraction_dataset_sha256"] = extraction_fingerprint
    output.mkdir(parents=True, exist_ok=True)
    output.chmod(0o700)
    salt_path = output / "private-salt.hex"
    with salt_path.open("x", encoding="ascii") as stream:
        stream.write(salt.hex() + "\n")
    salt_path.chmod(0o600)
    schema_path = output / "schema.json"
    _write_json(schema_path, _SCHEMA)
    summary["schema_file_sha256"] = hashlib.sha256(schema_path.read_bytes()).hexdigest()
    summary["manifest_sha256"] = {}
    for partition, filename in _FILES.items():
        path = output / filename
        _write_json(path, prepared[partition], lines=True)
        summary["manifest_sha256"][filename] = hashlib.sha256(path.read_bytes()).hexdigest()
    # Completion marker last: missing/changed manifests or schemas cannot load.
    summary_path = output / "summary.json"
    _write_json(summary_path, summary)
    return {
        "train_manifest": str(output / "train.jsonl"),
        "validation_manifest": str(output / "validation.jsonl"),
        "summary_path": str(summary_path), "summary": summary,
    }


def load_multitask_manifest(path: Path) -> list[dict[str, Any]]:
    """Read a completed private manifest, checking schema, digests and row values."""
    path = Path(path)
    if path.name not in _FILES.values():
        raise ValueError("Choose an explicit prepared training or validation manifest.")
    try:
        summary = json.loads((path.parent / "summary.json").read_text(encoding="utf-8"))
        schema_payload = (path.parent / "schema.json").read_bytes()
        schema = json.loads(schema_payload)
        manifest_payloads = {filename: (path.parent / filename).read_bytes() for filename in _FILES.values()}
        if (
            not isinstance(summary, dict) or schema != _SCHEMA
            or summary.get("schema_version") != 1 or summary.get("task") != TASK
            or summary.get("manifest_schema_sha256") != _SCHEMA_DIGEST
            or summary.get("target_schema") != _SCHEMA["target_schema"]
            or summary.get("schema_file_sha256") != hashlib.sha256(schema_payload).hexdigest()
            or not isinstance(summary.get("manifest_sha256"), dict)
            or any(summary["manifest_sha256"].get(filename) != hashlib.sha256(payload).hexdigest() for filename, payload in manifest_payloads.items())
            or any(summary.get(flag) is not False for flag in ("grouping_verified", "label_semantics_verified", "region_label_compatibility_verified"))
        ):
            raise ValueError("Multitask manifest integrity verification failed.")
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError, AttributeError):
        raise ValueError("A complete, valid multitask preparation summary is required.") from None

    all_rows: dict[str, list[dict[str, Any]]] = {}
    seen_ids: set[str] = set()
    seen_images: set[str] = set()
    try:
        for filename, payload in manifest_payloads.items():
            rows = []
            expected_split = "train" if filename == "train.jsonl" else "validation"
            for line in payload.decode("utf-8").splitlines():
                row = json.loads(line)
                if not isinstance(row, dict) or set(row) != _ROW_KEYS:
                    raise ValueError("Invalid multitask manifest row schema.")
                if (
                    row["split"] != expected_split
                    or row["grouping_verified"] is not False
                    or not isinstance(row["sample_id"], str) or not re.fullmatch(r"[0-9a-f]{64}", row["sample_id"])
                    or not isinstance(row["image_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", row["image_sha256"])
                    or row["sample_id"] in seen_ids or row["image_sha256"] in seen_images
                    or row["region"] not in (*REGIONS, None)
                    or not isinstance(row["image_path"], str) or not Path(row["image_path"]).is_absolute()
                    or Path(row["image_path"]).suffix.casefold() not in (".jpg", ".jpeg")
                    or row["image_member"] is not None
                    or not isinstance(row["labels"], dict) or set(row["labels"]) != set(TARGETS)
                    or any(code is not None and code not in TARGETS[target] for target, code in row["labels"].items())
                    or not any(code is not None for code in row["labels"].values())
                ):
                    raise ValueError("Invalid multitask manifest row values.")
                seen_ids.add(row["sample_id"])
                seen_images.add(row["image_sha256"])
                rows.append(row)
            if not rows:
                raise ValueError("Multitask manifest is empty.")
            all_rows[filename] = rows
    except (UnicodeError, json.JSONDecodeError, TypeError):
        raise ValueError("Multitask manifests must contain valid UTF-8 JSON rows.") from None
    return all_rows[path.name]
