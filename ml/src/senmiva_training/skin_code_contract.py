"""Exact, experimental source-category interoperability, without clinical claims.

The ingredient experiment hashes a complete eight-code condition as one feature.
Its private support file proves that each permitted category belonged to an
immutable retained training profile. Runtime never needs source records, image
links, answers or demographic witnesses outside this module.
"""

from __future__ import annotations

from collections.abc import Mapping
import hashlib
import json
import math
from pathlib import Path

from . import recommendation as training
from .multitask_data import TARGETS
from .workspace import private_output


CONTRACT_VERSION = "aihub71886-source-codes-v1"
TARGET_ORDER = ("sensitivity", "pigmentation", "wrinkles", "acne", "pores", "sagging", "keratin", "redness")
_MAX_CONDITIONS = math.prod(len(TARGETS[key]) for key in TARGET_ORDER)
_MAX_SOURCE_FILES = 50_000
_MAX_ARTIFACT_BYTES = 4 * 1024 * 1024
_ERROR = "The private source-code support contract could not be verified."


def visual_condition_token(mapping: Mapping[str, str]) -> str:
    """Serialize the exact source order; code alphabets imply no severity scale."""
    if not isinstance(mapping, Mapping) or set(mapping) != set(TARGET_ORDER):
        raise ValueError("Exactly eight supported visual code heads are required.")
    if any(not isinstance(mapping[key], str) or mapping[key] not in TARGETS[key] for key in TARGET_ORDER):
        raise ValueError("Visual codes do not match the source categorical schema.")
    return training._category("/".join(mapping[key] for key in TARGET_ORDER), "initial_skin_condition")


def _source_token(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError(_ERROR)
    codes = value.split("/")
    if len(codes) != len(TARGET_ORDER):
        raise ValueError(_ERROR)
    return visual_condition_token(dict(zip(TARGET_ORDER, codes)))


def _train_profiles(rows: dict) -> dict[str, tuple[int, ...]]:
    profiles: dict[str, tuple[int, ...]] = {}
    for row in rows["train"]:
        profile = row["profile_sha256"]
        features = tuple(row["features"])
        if profile in profiles and profiles[profile] != features:
            raise ValueError(_ERROR)
        profiles[profile] = features
    if not profiles:
        raise ValueError(_ERROR)
    return profiles


def _body(summary: dict, witnesses: list[dict], profile_count: int) -> dict:
    return {
        "schema_version": 1,
        "contract_version": CONTRACT_VERSION,
        "manifest_sha256": summary["manifest_sha256"],
        "source_fingerprint_sha256": summary["source_fingerprint_sha256"],
        "feature_policy": "sha256-binary-profile-categories-v1",
        "target_order": list(TARGET_ORDER),
        "code_domains": {key: list(TARGETS[key]) for key in TARGET_ORDER},
        "clinical_semantics_verified": False,
        "image_annotation_linkage_verified": False,
        "support_policy": "exact-whole-condition-retained-train-profile-witness-v1",
        "retained_train_profile_count": profile_count,
        "witnesses": witnesses,
    }


def load_condition_support(path: Path, rows: dict, summary: dict) -> frozenset[str]:
    """Verify private witnesses against already verified immutable train rows.

    The self-digest catches corruption; the profile hash and exact prepared
    feature-vector match establish membership without trusting that digest.
    Witness tokens must never be returned to the HTTP/application layer.
    """
    try:
        raw_path = Path(path)
        if raw_path.is_symlink():
            raise ValueError(_ERROR)
        path = private_output(raw_path)
        if not path.is_file() or path.stat().st_size > _MAX_ARTIFACT_BYTES:
            raise ValueError(_ERROR)
        artifact = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(artifact, dict) or "sha256" not in artifact:
            raise ValueError(_ERROR)
        body = {key: value for key, value in artifact.items() if key != "sha256"}
        if artifact["sha256"] != hashlib.sha256(training._json_bytes(body)).hexdigest():
            raise ValueError(_ERROR)
        witnesses = body.get("witnesses")
        profiles = _train_profiles(rows)
        if (not isinstance(witnesses, list) or not 1 <= len(witnesses) <= _MAX_CONDITIONS
                or training._json_bytes(body) != training._json_bytes(_body(summary, witnesses, len(profiles)))):
            raise ValueError(_ERROR)
        support = set()
        for witness in witnesses:
            if not isinstance(witness, dict) or set(witness) != {"condition_token", "profile_sha256", "feature_tokens"}:
                raise ValueError(_ERROR)
            tokens, profile, condition = witness["feature_tokens"], witness["profile_sha256"], witness["condition_token"]
            if (not isinstance(tokens, list) or not 4 <= len(tokens) <= 44
                    or any(not isinstance(token, str) or not token or len(token) > 512 for token in tokens)
                    or tokens != sorted(set(tokens)) or not isinstance(profile, str)
                    or profile not in profiles
                    or hashlib.sha256(training._json_bytes(tuple(tokens))).hexdigest() != profile
                    or tuple(training._feature_indices(tuple(tokens))) != profiles[profile]):
                raise ValueError(_ERROR)
            conditions = [token for token in tokens if token.startswith("initial_skin_condition=")]
            if conditions != [condition] or not isinstance(condition, str):
                raise ValueError(_ERROR)
            # Source serialization is canonical uppercase before the original
            # category normalizer turns it into a lowercase model feature.
            canonical = _source_token(condition.removeprefix("initial_skin_condition=").upper())
            if canonical != condition or condition in support:
                raise ValueError(_ERROR)
            support.add(condition)
        if [item["condition_token"] for item in witnesses] != sorted(support):
            raise ValueError(_ERROR)
        return frozenset(support)
    except Exception:
        raise ValueError(_ERROR) from None


def build_condition_support(source: Path, manifest: Path, output: Path) -> dict:
    """Explicit offline audit; create one separate immutable private sidecar.

    Every source JSONL byte participates in the existing manifest fingerprint.
    Retained training-profile coverage is exact; validation profiles cannot
    supply witnesses. Neither the original manifest nor source files are edited.
    """
    try:
        raw_source, raw_manifest = Path(source), Path(manifest)
        if raw_source.is_symlink() or raw_manifest.is_symlink():
            raise ValueError(_ERROR)
        source = raw_source.resolve()
        manifest = private_output(raw_manifest)
        raw_output = Path(output)
        if raw_output.is_symlink():
            raise ValueError(_ERROR)
        output = private_output(raw_output, source)
        private_output(output, manifest)
        if output.exists() or not source.is_dir():
            raise ValueError(_ERROR)
        rows, _vocabulary, summary = training._load_prepared(manifest)
        profiles = _train_profiles(rows)
        paths = []
        for path in source.rglob("*"):
            if path.is_symlink() or not path.resolve().is_relative_to(source):
                raise ValueError(_ERROR)
            paths.append(path)
            if len(paths) > _MAX_SOURCE_FILES:
                raise ValueError(_ERROR)
        paths.sort()
        workbooks = [path for path in paths if path.is_file() and path.suffix.casefold() == ".xlsx"]
        if len(workbooks) != 1:
            raise ValueError(_ERROR)
        witnesses: dict[str, dict] = {}
        matched = set()
        fingerprints = []
        record_count = 0
        for path in paths:
            if not path.is_file() or path.suffix.casefold() != ".jsonl":
                continue
            split = training._partition(path, source)
            if split not in ("train", "validation"):
                raise ValueError(_ERROR)
            before = path.stat()
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                while line := stream.readline(training._MAX_LINE + 1):
                    if len(line) > training._MAX_LINE:
                        raise ValueError(_ERROR)
                    digest.update(line)
                    if not line.strip():
                        continue
                    record_count += 1
                    if record_count > training._MAX_ROWS:
                        raise ValueError(_ERROR)
                    record = json.loads(line)
                    tokens = training._feature_tokens(record)
                    condition = _source_token(record["meta"]["initial_skin_condition"])
                    if condition not in tokens:
                        raise ValueError(_ERROR)
                    profile = hashlib.sha256(training._json_bytes(tokens)).hexdigest()
                    if split == "train" and profile in profiles:
                        if tuple(training._feature_indices(tokens)) != profiles[profile]:
                            raise ValueError(_ERROR)
                        matched.add(profile)
                        witness = {"condition_token": condition, "profile_sha256": profile, "feature_tokens": list(tokens)}
                        if condition not in witnesses or profile < witnesses[condition]["profile_sha256"]:
                            witnesses[condition] = witness
                        if len(witnesses) > _MAX_CONDITIONS:
                            raise ValueError(_ERROR)
            after = path.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ValueError(_ERROR)
            fingerprints.append((path.relative_to(source).as_posix(), digest.hexdigest()))
        fingerprints.append((workbooks[0].relative_to(source).as_posix(), training._sha(workbooks[0])))
        if (matched != set(profiles)
                or hashlib.sha256(training._json_bytes(fingerprints)).hexdigest() != summary["source_fingerprint_sha256"]):
            raise ValueError(_ERROR)
        body = _body(summary, [witnesses[token] for token in sorted(witnesses)], len(profiles))
        artifact = {**body, "sha256": hashlib.sha256(training._json_bytes(body)).hexdigest()}
        if len(training._json_bytes(artifact)) > _MAX_ARTIFACT_BYTES:
            raise ValueError(_ERROR)
        # Verify before writing; source auditing must not mutate existing runs.
        output.parent.mkdir(parents=True, exist_ok=True)
        # Auditing is intentionally slower than serving: recheck the requested
        # location after that scan, then use the existing O_EXCL/0600 writer.
        if (raw_output.is_symlink() or private_output(raw_output, source) != output
                or private_output(raw_output, manifest) != output):
            raise ValueError(_ERROR)
        training._write(output, artifact)
        support = load_condition_support(output, rows, summary)
        return {"contract_version": CONTRACT_VERSION, "condition_count": len(support),
                "retained_train_profile_count": len(profiles), "source_records_audited": record_count,
                "sha256": artifact["sha256"], "clinical_semantics_verified": False,
                "image_annotation_linkage_verified": False}
    except Exception:
        raise ValueError(_ERROR) from None
