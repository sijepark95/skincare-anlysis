"""Private, offline CSV/JPG preparation for the supplied AI-Hub package.

Source partitions are retained. Record grouping is explicitly unverified; image
hash checks exclude exact duplicates, not different photographs of one person.
This module uses only the standard library and never decodes or copies images.
"""

from __future__ import annotations

import csv
import hashlib
import hmac
import io
import json
import os
from pathlib import Path, PurePosixPath
import random
import re
import secrets
from collections import Counter, defaultdict
from typing import Any
import zipfile

from senmiva_training.workspace import private_output


LABELS = ("NVP", "VP")
_REGION_COLUMN = "이미지 부위 (상/중/하)"
_LABEL_COLUMN = "모공 (육안 평가)"
_REQUIRED_COLUMNS = {"No", _REGION_COLUMN, _LABEL_COLUMN}
_MAX_CSV_BYTES = 1024 * 1024
_MAX_IMAGE_BYTES = 40 * 1024 * 1024
_ROW_KEYS = {
    "sample_id", "label", "split", "image_path", "image_member",
    "source_partition", "region", "group_id", "grouping_verified", "image_sha256",
}
_SCHEMA_DIGEST = hashlib.sha256(json.dumps(sorted(_ROW_KEYS), separators=(",", ":")).encode()).hexdigest()


def _inside(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def _partition(name: str) -> str | None:
    if name.startswith("TS_"):
        return "training"
    if name.startswith("VS_"):
        return "validation"
    return None


def _extracted_partition(path: Path, source: Path) -> str | None:
    for part in path.relative_to(source).parts[:-1]:
        partition = _partition(part)
        if partition:
            return partition
    return None


def _safe_member(member: str) -> bool:
    # Reading never extracts ZIP entries, but still reject ambiguous paths and
    # Windows drive/UNC syntax so manifests cannot later become extraction lists.
    path = PurePosixPath(member)
    return bool(member) and not (
        path.is_absolute() or "\\" in member or ":" in member
        or ".." in path.parts or "\x00" in member
    )


def _read_zip_member(archive: zipfile.ZipFile, member: str, maximum: int) -> bytes:
    if not _safe_member(member):
        raise ValueError("Unsafe source archive entry.")
    try:
        info = archive.getinfo(member)
    except KeyError:
        raise ValueError("A manifest source archive entry is no longer available.") from None
    if info.is_dir() or info.file_size <= 0 or info.file_size > maximum:
        raise ValueError("Source entry has an invalid or excessive size.")
    with archive.open(info) as stream:
        payload = stream.read(maximum + 1)
    if len(payload) > maximum or len(payload) != info.file_size:
        raise ValueError("Source entry could not be read within its size limit.")
    return payload


def _read_file(path: Path, maximum: int) -> bytes:
    if path.stat().st_size <= 0 or path.stat().st_size > maximum:
        raise ValueError("Source file has an invalid or excessive size.")
    with path.open("rb") as stream:
        payload = stream.read(maximum + 1)
    if len(payload) > maximum:
        raise ValueError("Source file exceeds its size limit.")
    return payload


def _parse_csv(payload: bytes) -> dict[str, str]:
    try:
        reader = csv.DictReader(io.StringIO(payload.decode("utf-8-sig")))
        if not _REQUIRED_COLUMNS.issubset(reader.fieldnames or []):
            raise ValueError("Source CSV is missing required schema columns.")
        records = list(reader)
    except (UnicodeError, csv.Error):
        raise ValueError("Source CSV is not valid UTF-8 CSV.") from None
    if len(records) != 1 or None in records[0] or any(value is None for value in records[0].values()):
        raise ValueError("Each source CSV must contain exactly one complete record.")
    return {key: value.strip() for key, value in records[0].items()}


def _record_key(value: str) -> str:
    if not value or len(value) > 256:
        raise ValueError("A source record identifier is missing or invalid.")
    # Spreadsheet exports sometimes change integer spelling. This normalization
    # identifies repeated records only; it does not establish person identity.
    if re.fullmatch(r"[0-9]+(?:\.0+)?", value):
        return str(int(value.split(".")[0]))
    return value


def _pseudonym(salt: bytes, value: str) -> str:
    return hmac.new(salt, b"record:" + value.encode("utf-8"), hashlib.sha256).hexdigest()


def _load_or_create_salt(output: Path) -> bytes:
    path = output / "private-salt.hex"
    if path.exists():
        try:
            salt = bytes.fromhex(path.read_text(encoding="ascii").strip())
        except (ValueError, UnicodeError):
            raise ValueError("The private manifest salt is invalid.") from None
        if len(salt) != 32:
            raise ValueError("The private manifest salt is invalid.")
        return salt
    salt = secrets.token_bytes(32)
    with path.open("x", encoding="ascii") as stream:
        stream.write(salt.hex() + "\n")
    path.chmod(0o600)
    return salt


def _stratified_limit(rows: list[dict[str, Any]], limit: int | None, seed: int) -> list[dict[str, Any]]:
    ordered = sorted(rows, key=lambda row: row["sample_id"])
    if limit is None or len(ordered) <= limit:
        return ordered
    groups = {label: [row for row in ordered if row["label"] == label] for label in LABELS}
    present = {label: group for label, group in groups.items() if group}
    if limit < len(present):
        raise ValueError("The per-partition limit must accommodate every present class.")
    counts = {label: 1 for label in present}
    # Allocate each remaining place to the largest unmet proportional quota.
    for _ in range(limit - len(present)):
        available = [label for label, group in present.items() if counts[label] < len(group)]
        label = max(available, key=lambda label: (limit * len(present[label]) / len(rows) - counts[label], label))
        counts[label] += 1
    rng = random.Random(seed)
    selected: list[dict[str, Any]] = []
    for label in sorted(present):
        group = present[label].copy()
        rng.shuffle(group)
        selected.extend(group[:counts[label]])
    return sorted(selected, key=lambda row: row["sample_id"])


def _write_json(path: Path, value: Any, *, lines: bool = False) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        if lines:
            for row in value:
                stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
        else:
            json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
    temporary.chmod(0o600)
    os.replace(temporary, path)


def prepare_dataset(
    source: Path, output: Path, seed: int = 42, limit: int | None = None,
    cross_split_policy: str = "reject",
) -> dict[str, Any]:
    """Write private manifests without copying images or reading recommendation text.

    ``limit`` caps each partition independently, preserving both available codes.
    All matched images are hashed before sampling. Cross-partition exact image
    duplicates fail preparation by default. Explicit ``exclude-all`` instead
    quarantines every occurrence of each shared byte hash from both partitions,
    before class checks and sampling, without modifying source files. Publisher
    validation is for model selection, not independent testing; person separation
    remains unverified under either policy.
    """
    source, output = Path(source).resolve(), Path(output).resolve()
    if not source.is_dir():
        raise ValueError("The source dataset directory does not exist.")
    if type(seed) is not int or (limit is not None and (type(limit) is not int or limit < 1)):
        raise ValueError("Seed must be an integer and limit must be a positive integer.")
    if cross_split_policy not in ("reject", "exclude-all"):
        raise ValueError("Cross-split policy must be reject or exclude-all.")
    output = private_output(output, source)
    output.mkdir(parents=True, exist_ok=True)
    output.chmod(0o700)
    if any((output / name).exists() for name in ("train.jsonl", "validation.jsonl", "summary.json")):
        raise ValueError("Prepared manifests are immutable; choose a new output directory.")
    salt = _load_or_create_salt(output)
    rows: dict[str, list[dict[str, Any]]] = {"training": [], "validation": []}
    counts: dict[str, Counter[str]] = {"training": Counter(), "validation": Counter()}
    records_seen: set[str] = set()
    images_seen: dict[str, set[str]] = {}
    image_occurrences: dict[str, Counter[str]] = defaultdict(Counter)
    source_fingerprints: dict[str, list[str]] = {"training": [], "validation": []}

    def accept(csv_payload: bytes, image_payload: bytes, partition: str, image_path: Path, member: str | None) -> None:
        record = _parse_csv(csv_payload)
        sample_id = _pseudonym(salt, _record_key(record["No"]))
        if sample_id in records_seen:
            raise ValueError("Repeated source record identifiers require a verified mapping.")
        records_seen.add(sample_id)
        counts[partition]["source_pairs"] += 1
        digest = hashlib.sha256(image_payload).hexdigest()
        source_fingerprints[partition].append(hashlib.sha256(json.dumps({
            "sample_id": sample_id, "image_sha256": digest,
            "region": record[_REGION_COLUMN], "label": record[_LABEL_COLUMN],
        }, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
        previous_partitions = images_seen.setdefault(digest, set())
        if previous_partitions and partition not in previous_partitions and cross_split_policy == "reject":
            raise ValueError("Exact image duplication crosses training and validation; preparation stopped.")
        if partition in previous_partitions:
            counts[partition]["exact_duplicate_images"] += 1
        previous_partitions.add(partition)
        image_occurrences[digest][partition] += 1
        if record[_REGION_COLUMN] != "중":
            counts[partition]["excluded_region"] += 1
            return
        counts[partition]["middle_region"] += 1
        label = record[_LABEL_COLUMN]
        if not label:
            counts[partition]["excluded_missing_label"] += 1
            return
        if label not in LABELS:
            counts[partition]["excluded_invalid_label"] += 1
            return
        rows[partition].append({
            "sample_id": sample_id, "group_id": sample_id,
            "label": label, "split": "train" if partition == "training" else "validation",
            "image_path": str(image_path), "image_member": member,
            "image_sha256": digest,
            "source_partition": partition, "region": "중", "grouping_verified": False,
        })

    files = sorted((path for path in source.rglob("*") if path.is_file()), key=lambda path: str(path).casefold())
    extracted: dict[tuple[str, str], dict[str, Path]] = defaultdict(dict)
    for path in files:
        partition = _extracted_partition(path, source)
        if not partition or path.suffix.casefold() not in (".csv", ".jpg", ".jpeg"):
            continue
        resolved = path.resolve()
        if not _inside(resolved, source):
            raise ValueError("An extracted source file resolves outside the dataset directory.")
        kind = "csv" if path.suffix.casefold() == ".csv" else "image"
        key = (partition, str(path.with_suffix("")).casefold())
        if kind in extracted[key]:
            raise ValueError("Ambiguous extracted image/CSV pairing.")
        extracted[key][kind] = resolved
    for (partition, _), pair in extracted.items():
        if set(pair) != {"csv", "image"}:
            raise ValueError("An extracted source image/CSV pair is incomplete.")
        accept(_read_file(pair["csv"], _MAX_CSV_BYTES), _read_file(pair["image"], _MAX_IMAGE_BYTES), partition, pair["image"], None)

    for archive_path in (path for path in files if path.suffix.casefold() == ".zip"):
        partition = _partition(archive_path.name)
        if not partition:
            continue
        resolved = archive_path.resolve()
        if not _inside(resolved, source):
            raise ValueError("A source archive resolves outside the dataset directory.")
        with zipfile.ZipFile(resolved) as archive:
            pairs: dict[str, dict[str, str]] = defaultdict(dict)
            member_names: set[str] = set()
            for info in archive.infolist():
                if not _safe_member(info.filename):
                    raise ValueError("Unsafe source archive entry.")
                if info.filename in member_names:
                    raise ValueError("Repeated source archive entries are ambiguous.")
                member_names.add(info.filename)
                if info.is_dir():
                    continue
                member_path = PurePosixPath(info.filename)
                suffix = member_path.suffix.casefold()
                if suffix not in (".csv", ".jpg", ".jpeg"):
                    continue
                kind = "csv" if suffix == ".csv" else "image"
                key = str(member_path.with_suffix("")).casefold()
                if kind in pairs[key]:
                    raise ValueError("Ambiguous archived image/CSV pairing.")
                pairs[key][kind] = info.filename
            for pair in pairs.values():
                if set(pair) != {"csv", "image"}:
                    raise ValueError("An archived source image/CSV pair is incomplete.")
                accept(_read_zip_member(archive, pair["csv"], _MAX_CSV_BYTES), _read_zip_member(archive, pair["image"], _MAX_IMAGE_BYTES), partition, resolved, pair["image"])

    cross_split_hashes = {digest for digest, partitions in images_seen.items() if len(partitions) > 1}
    # Quarantine before same-partition deduplication: every eligible occurrence
    # of a shared hash is excluded, even if repeated several times or carrying
    # conflicting labels. Conflicts among retained images still fail closed.
    for partition, candidates in rows.items():
        retained: list[dict[str, Any]] = []
        eligible_images: dict[str, str] = {}
        counts[partition]["excluded_cross_split_source_pairs"] = sum(image_occurrences[digest][partition] for digest in cross_split_hashes)
        counts[partition]["excluded_cross_split_eligible_records"] = 0
        for row in candidates:
            digest = row["image_sha256"]
            if digest in cross_split_hashes:
                counts[partition]["excluded_cross_split_eligible_records"] += 1
                continue
            previous_label = eligible_images.get(digest)
            if previous_label:
                if previous_label != row["label"]:
                    raise ValueError("An exact image has conflicting pore labels; preparation stopped.")
                counts[partition]["excluded_duplicate_eligible_image"] += 1
                continue
            eligible_images[digest] = row["label"]
            retained.append(row)
        rows[partition] = retained

    if not rows["training"] or not rows["validation"]:
        raise ValueError("Both source partitions must contain eligible middle-region pore records.")
    if any({row["label"] for row in partition_rows} != set(LABELS) for partition_rows in rows.values()):
        raise ValueError("Both pore codes must be present in each partition for this experiment.")
    selected = {partition: _stratified_limit(partition_rows, limit, seed) for partition, partition_rows in rows.items()}
    summary = {
        "schema_version": 1,
        "manifest_schema_sha256": _SCHEMA_DIGEST,
        "task": "middle-region-source-pore-code-classification",
        "labels": list(LABELS), "seed": seed, "limit_per_partition": limit,
        "grouping_verified": False,
        "grouping_basis": "pseudonymized source record; person identity unverified",
        "image_hash_audit": "all matched source images; no exact cross-partition duplicates retained",
        "cross_split_policy": cross_split_policy,
        "cross_split_duplicate_hash_groups": len(cross_split_hashes),
        "validation_role": "publisher validation for model selection; no independent test set",
        "source_partition_sha256": {
            partition: hashlib.sha256("\n".join(sorted(fingerprints)).encode()).hexdigest()
            for partition, fingerprints in source_fingerprints.items()
        },
        "partitions": {
            partition: {
                **dict(counts[partition]),
                "eligible_records": len(rows[partition]),
                "eligible_label_counts": dict(Counter(row["label"] for row in rows[partition])),
                "selected_records": len(selected[partition]),
                "selected_label_counts": dict(Counter(row["label"] for row in selected[partition])),
            } for partition in ("training", "validation")
        },
    }
    train_path, validation_path, summary_path = output / "train.jsonl", output / "validation.jsonl", output / "summary.json"
    _write_json(train_path, selected["training"], lines=True)
    _write_json(validation_path, selected["validation"], lines=True)
    summary["manifest_sha256"] = {
        "train.jsonl": hashlib.sha256(train_path.read_bytes()).hexdigest(),
        "validation.jsonl": hashlib.sha256(validation_path.read_bytes()).hexdigest(),
    }
    # Written last: readers reject partially prepared or subsequently changed
    # manifests. Completed directories are immutable and never overwritten.
    _write_json(summary_path, summary)
    return {"train_manifest": str(train_path), "validation_manifest": str(validation_path), "summary_path": str(summary_path), "summary": summary}


def load_manifest(path: Path) -> list[dict[str, Any]]:
    """Load the explicit private manifest schema, rejecting arbitrary extensions."""
    path = Path(path)
    try:
        summary = json.loads((path.parent / "summary.json").read_text(encoding="utf-8"))
        if (
            summary.get("manifest_schema_sha256") != _SCHEMA_DIGEST
            or summary.get("manifest_sha256", {}).get(path.name) != hashlib.sha256(path.read_bytes()).hexdigest()
        ):
            raise ValueError("Manifest integrity verification failed.")
    except (FileNotFoundError, UnicodeError, json.JSONDecodeError, AttributeError):
        raise ValueError("A complete, valid preparation summary is required.") from None
    rows = []
    seen: set[str] = set()
    try:
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                row = json.loads(line)
                if not isinstance(row, dict) or set(row) != _ROW_KEYS:
                    raise ValueError("Invalid manifest row schema.")
                if (
                    row["label"] not in LABELS or row["split"] not in ("train", "validation")
                    or row["region"] != "중" or row["grouping_verified"] is not False
                    or not isinstance(row["sample_id"], str)
                    or not re.fullmatch(r"[0-9a-f]{64}", row["sample_id"])
                    or row["group_id"] != row["sample_id"]
                    or not isinstance(row["image_sha256"], str)
                    or not re.fullmatch(r"[0-9a-f]{64}", row["image_sha256"])
                    or row["source_partition"] != ("training" if row["split"] == "train" else "validation")
                    or not isinstance(row["image_path"], str) or not Path(row["image_path"]).is_absolute()
                    or (row["image_member"] is not None and (not isinstance(row["image_member"], str) or not _safe_member(row["image_member"])))
                    or row["sample_id"] in seen
                ):
                    raise ValueError("Invalid manifest row values.")
                seen.add(row["sample_id"])
                rows.append(row)
    except (json.JSONDecodeError, UnicodeError):
        raise ValueError("Manifest must contain valid UTF-8 JSON lines.") from None
    if not rows:
        raise ValueError("Manifest is empty.")
    return rows


def load_image_bytes(row: dict[str, Any]) -> bytes:
    """Read a bounded image directly from its local path or ZIP without extraction."""
    path = Path(row["image_path"])
    if not path.is_absolute():
        raise ValueError("Manifest image paths must be absolute.")
    member = row["image_member"]
    if member is None:
        if path.suffix.casefold() not in (".jpg", ".jpeg"):
            raise ValueError("Manifest image file must be a JPEG.")
        payload = _read_file(path, _MAX_IMAGE_BYTES)
        if hashlib.sha256(payload).hexdigest() != row.get("image_sha256"):
            raise ValueError("Source image changed after manifest preparation.")
        return payload
    if not isinstance(member, str) or not _safe_member(member) or path.suffix.casefold() != ".zip" or PurePosixPath(member).suffix.casefold() not in (".jpg", ".jpeg"):
        raise ValueError("Manifest archive image reference is invalid.")
    with zipfile.ZipFile(path) as archive:
        payload = _read_zip_member(archive, member, _MAX_IMAGE_BYTES)
    if hashlib.sha256(payload).hexdigest() != row.get("image_sha256"):
        raise ValueError("Source image changed after manifest preparation.")
    return payload
