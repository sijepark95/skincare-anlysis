"""Private structured-profile to ingredient candidate research with silver labels.

Answers are used only to derive heuristic targets, never model inputs. This
experiment does not join images/CSV, prove efficacy, prescribe concentrations,
or replace the application's reviewed recommendation policy.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import random
import re
import secrets
import unicodedata
import uuid
import xml.etree.ElementTree as ET
import zipfile

from .workspace import private_output


_DIMENSION = 2048
_MAX_XML = 32 * 1024**2
_MAX_LINE = 2 * 1024**2
_MAX_ROWS = 100_000
_MAX_ANSWER = 200_000
_MAX_LABELS = 5000
_NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
_POLICY = "exact-unambiguous-alias-longest-overlap; negative-sentence-excluded; unreviewed-silver-v1"
_NEGATIVE = re.compile(r"피하|피해야|피하는|피하세요|배제|(?:권장|추천|사용)\s*(?:하지|되지|하면\s*안)|적합하지|금지|금물|제외|삼가|쓰지\s*마|사용을?\s*피|알레르기.*유발|\bavoid\b|\bwithout\b|\bfree[ -]from\b|\bnot\s+(?:recommended|suitable)\b|\b(?:do|should|must)\s+not\b|\bcontraindicat", re.IGNORECASE)
_DIGEST = re.compile(r"[0-9a-f]{64}\Z")
_PARTICLES = {"은", "는", "이", "가", "을", "를", "과", "와", "도", "에", "의", "로", "으로", "부터", "까지", "처럼", "에는", "에서", "에만", "만", "보다", "보다는", "입니다", "이고", "이며", "인", "나"}


def _json_bytes(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _write(path: Path, value, *, lines: bool = False) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
        if lines:
            for row in value:
                stream.write(_json_bytes(row).decode("utf-8") + "\n")
        else:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write("\n")
    path.chmod(0o600)


def _fresh(output: Path, source: Path) -> Path:
    output = private_output(Path(output), source)
    if output.exists():
        raise ValueError("Recommendation artifacts are immutable; choose a fresh output directory.")
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    output.mkdir(mode=0o700)
    return output


def _normalize(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).split()).casefold()


def _xml(archive: zipfile.ZipFile, name: str) -> ET.Element:
    try:
        info = archive.getinfo(name)
    except KeyError:
        raise ValueError("Ingredient workbook has an unsupported structure.") from None
    if info.file_size > _MAX_XML or info.flag_bits & 1:
        raise ValueError("Ingredient workbook XML exceeds its safety limit.")
    with archive.open(info) as stream:
        payload = stream.read(_MAX_XML + 1)
    if len(payload) != info.file_size or len(payload) > _MAX_XML or b"<!DOCTYPE" in payload.upper() or b"<!ENTITY" in payload.upper():
        raise ValueError("Unsafe ingredient workbook XML.")
    return ET.fromstring(payload)


def _ingredient_dictionary(path: Path) -> tuple[dict[str, str], dict]:
    with zipfile.ZipFile(path) as archive:
        if len(archive.infolist()) > 1000:
            raise ValueError("Ingredient workbook entry limit exceeded.")
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            strings = ["".join(item.itertext()) for item in _xml(archive, "xl/sharedStrings.xml").findall("s:si", _NS)]
        if len(strings) > 100_000:
            raise ValueError("Ingredient workbook string limit exceeded.")
        root = _xml(archive, "xl/worksheets/sheet1.xml")
    rows = root.findall("s:sheetData/s:row", _NS)
    if not rows or len(rows) > 50_000:
        raise ValueError("Ingredient workbook row limit exceeded.")
    def cells(row) -> dict[str, str]:
        values = {}
        for cell in row.findall("s:c", _NS):
            column = re.sub(r"[0-9]", "", cell.attrib.get("r", ""))
            text = cell.findtext("s:v", default="", namespaces=_NS)
            if cell.attrib.get("t") == "s":
                try:
                    text = strings[int(text)]
                except (ValueError, IndexError):
                    raise ValueError("Ingredient workbook string reference is invalid.") from None
            elif cell.attrib.get("t") == "inlineStr":
                text = "".join(cell.find("s:is", _NS).itertext())
            values[column] = text.strip()
        return values
    headers = {re.sub(r"\s+", "", value): key for key, value in cells(rows[0]).items()}
    if not {"성분명(INCI)", "한글명"}.issubset(headers):
        raise ValueError("Ingredient workbook is missing INCI and Korean-name columns.")
    candidates: dict[str, set[str]] = {}
    canonical: dict[str, str] = {}
    ingredient_rows = 0
    for row in rows[1:]:
        values = cells(row)
        inci = values.get(headers["성분명(INCI)"], "").strip()
        korean = values.get(headers["한글명"], "").strip()
        if not inci:
            continue
        if len(inci) > 256 or len(korean) > 256:
            raise ValueError("Ingredient workbook name exceeds its length limit.")
        canonical.setdefault(_normalize(inci), inci)
        ingredient_rows += 1
        for alias in (inci, korean):
            normalized = _normalize(alias)
            if len(normalized) >= 2:
                candidates.setdefault(normalized, set()).add(_normalize(inci))
    if not canonical or len(canonical) > _MAX_LABELS:
        raise ValueError("Ingredient dictionary is empty or exceeds its label limit.")
    aliases = {alias: canonical[next(iter(names))] for alias, names in candidates.items() if len(names) == 1}
    return aliases, {"ingredient_workbook_rows": ingredient_rows, "canonical_ingredient_count": len(canonical),
                     "unambiguous_alias_count": len(aliases), "ambiguous_aliases_excluded": sum(len(names) != 1 for names in candidates.values())}


def _matcher(aliases: dict[str, str]):
    # A trie bounds scanning by matching prefixes instead of trying thousands
    # of regex alternatives at each character of every answer.
    trie = {}
    for alias in aliases:
        node = trie
        for char in alias:
            node = node.setdefault(char, {})
        node[None] = alias
    return trie


def _targets(answer: str, aliases: dict[str, str], matcher) -> set[str]:
    targets = set()
    for raw_sentence in re.split(r"(?<=[.!?。！？])\s+|\n|;", unicodedata.normalize("NFKC", answer)):
        sentence = _normalize(raw_sentence)
        if _NEGATIVE.search(sentence):
            continue
        spans = []
        for start in range(len(sentence)):
            node = matcher
            end = start
            while end < len(sentence) and sentence[end] in node:
                node = node[sentence[end]]
                end += 1
                alias = node.get(None)
                if alias is None:
                    continue
                if start and (sentence[start - 1].isalnum() or sentence[start - 1] == "_"):
                    continue
                if end < len(sentence) and (sentence[end].isalnum() or sentence[end] == "_"):
                    suffix = re.match(r"[가-힣]+", sentence[end:])
                    if suffix is None or suffix.group(0) not in _PARTICLES:
                        continue
                spans.append((start, end, alias))
        occupied = set()
        for start, end, alias in sorted(spans, key=lambda item: (item[0] - item[1], item[0], item[2])):
            if occupied.isdisjoint(range(start, end)):
                targets.add(aliases[alias])
                occupied.update(range(start, end))
    return targets


def _category(value, field: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 64 or any(ord(char) < 32 for char in value):
        raise ValueError("Recommendation structured feature schema is invalid.")
    return f"{field}={_normalize(value)}"


def _feature_tokens(record: dict) -> tuple[str, ...]:
    meta = record.get("meta")
    external = record.get("external", [])
    if not isinstance(meta, dict) or not isinstance(external, list) or len(external) > 20:
        raise ValueError("Recommendation structured feature schema is invalid.")
    age = meta.get("age")
    if type(age) is not int or not 0 <= age <= 120:
        raise ValueError("Recommendation age must be a bounded integer.")
    tokens = {f"age_bucket={min(age // 10, 10)}"}
    for field in ("gender", "skin_type", "initial_skin_condition"):
        tokens.add(_category(meta.get(field), field))
    concerns = meta.get("skin_concerns")
    if not isinstance(concerns, list) or len(concerns) > 20:
        raise ValueError("Recommendation skin concerns must be a bounded list.")
    tokens.update(_category(value, "concern") for value in concerns)
    for item in external:
        if not isinstance(item, dict):
            raise ValueError("Recommendation external-factor schema is invalid.")
        tokens.add(_category(item.get("factor"), "factor"))
    return tuple(sorted(tokens))


def _feature_indices(tokens: tuple[str, ...]) -> list[int]:
    return sorted({int.from_bytes(hashlib.sha256(token.encode("utf-8")).digest()[:8], "big") % _DIMENSION for token in tokens})


def _partition(path: Path, source: Path) -> str | None:
    partitions = set()
    for component in path.relative_to(source).parts[:-1]:
        if component.startswith("TL_"):
            partitions.add("train")
        if component.startswith("VL_"):
            partitions.add("validation")
    if len(partitions) > 1:
        raise ValueError("Recommendation label partitions conflict.")
    return next(iter(partitions)) if partitions else None


def _check_source(source: Path) -> None:
    if not source.is_dir():
        raise ValueError("Recommendation source directory does not exist.")
    if (source / "incomplete.json").exists():
        raise ValueError("Recommendation source extraction is incomplete.")
    index, summary = source / "extraction-index.json", source / "summary.json"
    if index.exists() or summary.exists():
        if not index.is_file() or not summary.is_file():
            raise ValueError("Recommendation source extraction is incomplete.")
        private = json.loads(index.read_text(encoding="utf-8"))
        aggregate = json.loads(summary.read_text(encoding="utf-8"))
        if private.get("complete") is not True or aggregate.get("complete") is not True or private.get("summary") != aggregate or not _DIGEST.fullmatch(aggregate.get("dataset_sha256", "")):
            raise ValueError("Recommendation source extraction integrity is invalid.")


def _prepare(source: Path, min_support: int) -> tuple[dict, dict, dict]:
    _check_source(source)
    if type(min_support) is not int or min_support < 1:
        raise ValueError("Minimum ingredient support must be a positive integer.")
    workbooks = sorted(source.rglob("*.xlsx"))
    if len(workbooks) != 1:
        raise ValueError("Recommendation source requires exactly one ingredient workbook.")
    if workbooks[0].is_symlink() or not workbooks[0].resolve().is_relative_to(source):
        raise ValueError("Recommendation workbook must remain inside its source.")
    aliases, dictionary_summary = _ingredient_dictionary(workbooks[0])
    matcher = _matcher(aliases)
    rows = {"train": [], "validation": []}
    fingerprints = []
    raw_counts = Counter()
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            raise ValueError("Recommendation source cannot contain symbolic links.")
        if not path.is_file() or path.suffix.casefold() != ".jsonl":
            continue
        split = _partition(path, source)
        if split is None:
            raise ValueError("Recommendation JSONL has no publisher label partition.")
        before = path.stat()
        with path.open("rb") as stream:
            digest = hashlib.sha256()
            while True:
                line = stream.readline(_MAX_LINE + 1)
                if not line:
                    break
                digest.update(line)
                if len(line) > _MAX_LINE:
                    raise ValueError("Recommendation record exceeds its line limit.")
                if not line.strip():
                    continue
                raw_counts[split] += 1
                if sum(raw_counts.values()) > _MAX_ROWS:
                    raise ValueError("Recommendation record count limit exceeded.")
                record = json.loads(line)
                if not isinstance(record, dict) or not isinstance(record.get("info"), dict):
                    raise ValueError("Recommendation record schema is invalid.")
                info = record["info"]
                answer, group = info.get("answer"), info.get("source_survey_id")
                if not isinstance(answer, str) or not answer or len(answer) > _MAX_ANSWER or not isinstance(group, str) or not group or len(group) > 256:
                    raise ValueError("Recommendation answer or source-survey schema is invalid.")
                tokens = _feature_tokens(record)
                profile = hashlib.sha256(_json_bytes(tokens)).hexdigest()
                group = hashlib.sha256(group.encode("utf-8")).hexdigest()
                rows[split].append({"tokens": tokens, "profile": profile, "survey": group,
                                    "input_hash": hashlib.sha256(_json_bytes(_feature_indices(tokens))).hexdigest(),
                                    "labels": _targets(answer, aliases, matcher)})
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError("Recommendation source changed during preparation.")
        fingerprints.append((path.relative_to(source).as_posix(), digest.hexdigest()))
    if not rows["train"] or not rows["validation"]:
        raise ValueError("Recommendation source needs training and validation label partitions.")
    shared_profiles = {row["profile"] for row in rows["train"]} & {row["profile"] for row in rows["validation"]}
    shared_surveys = {row["survey"] for row in rows["train"]} & {row["survey"] for row in rows["validation"]}
    shared_inputs = {row["input_hash"] for row in rows["train"]} & {row["input_hash"] for row in rows["validation"]}
    counts = {split: Counter({"source_records": len(values)}) for split, values in rows.items()}
    retained = {}
    for split, values in rows.items():
        seen = set()
        selected = []
        for row in values:
            if row["profile"] in shared_profiles or row["survey"] in shared_surveys or row["input_hash"] in shared_inputs:
                counts[split]["cross_partition_excluded"] += 1
                continue
            if not row["labels"]:
                counts[split]["no_positive_ingredient_match"] += 1
                continue
            key = (row["profile"], tuple(sorted(row["labels"])))
            if key in seen:
                counts[split]["exact_profile_target_duplicates"] += 1
                continue
            seen.add(key)
            selected.append(row)
        retained[split] = selected
    support = Counter(label for _profile, label in {(row["profile"], label) for row in retained["train"] for label in row["labels"]})
    names = sorted(label for label, count in support.items() if count >= min_support)
    if not names:
        raise ValueError("No ingredient labels meet training support after overlap exclusion.")
    vocabulary = {"schema_version": 1, "feature_dimension": _DIMENSION, "labels": names,
                  "feature_policy": "sha256-binary-profile-categories-v1", "target_policy": _POLICY}
    label_indices = {label: index for index, label in enumerate(names)}
    preparation_salt = secrets.token_bytes(32)
    manifests = {}
    for split, values in retained.items():
        selected = []
        seen_final = set()
        for row in values:
            unknown = row["labels"] - label_indices.keys()
            counts[split]["positive_mentions_outside_train_vocabulary"] += len(unknown)
            targets = sorted(label_indices[label] for label in row["labels"] if label in label_indices)
            if not targets:
                counts[split]["no_supported_positive_targets"] += 1
                continue
            final_key = (row["profile"], tuple(targets))
            if final_key in seen_final:
                counts[split]["duplicates_after_label_filter"] += 1
                continue
            seen_final.add(final_key)
            features = _feature_indices(row["tokens"])
            selected.append({"sample_id": hmac.new(preparation_salt, _json_bytes([row["profile"], targets]), hashlib.sha256).hexdigest(),
                             "profile_sha256": row["profile"], "features": features, "targets": targets})
        if not selected:
            raise ValueError("Recommendation partition has no usable supported-positive records.")
        manifests[split] = sorted(selected, key=lambda row: row["sample_id"])
        counts[split]["usable_records"] = len(selected)
    fingerprints.append((workbooks[0].relative_to(source).as_posix(), _sha(workbooks[0])))
    summary = {"schema_version": 1, "complete": True, "min_train_support": min_support,
               "minimum_support_unit": "distinct_structured_profile_not_verified_person",
               "feature_dimension": _DIMENSION, "label_count": len(names), "target_policy": _POLICY,
               "unreviewed_silver_labels": True, "candidate_prediction_only": True,
               "person_grouping_verified": False, "image_annotation_linkage_verified": False,
               "shared_source_survey_groups_excluded": len(shared_surveys), "shared_exact_profile_groups_excluded": len(shared_profiles),
               "shared_hashed_input_groups_excluded": len(shared_inputs),
               "partitions": {split: dict(value) for split, value in counts.items()}, **dictionary_summary,
               "source_fingerprint_sha256": hashlib.sha256(_json_bytes(fingerprints)).hexdigest(),
               "limitations": ["Ingredient mentions are unreviewed heuristic silver targets, not efficacy or safety evidence.",
                               "Unmentioned ingredients are weak 'not mentioned' targets, not clinical negatives; annotations may be incomplete.",
                               "Source-survey IDs and exact structured profiles are exclusion groups, not verified people.",
                               "Publisher validation supports model selection and is not independent product testing."]}
    return manifests, vocabulary, summary


def _audit_recommendation(source: Path, min_support: int = 10) -> dict:
    """Read-only aggregate coverage audit; does not write, train or decode images."""
    return _prepare(Path(source).resolve(), min_support)[2]


def prepare_recommendation(source: Path, output: Path, min_support: int = 10) -> dict:
    source = Path(source).resolve()
    # Validate the destination before reading licensed answers.
    private_output(Path(output), source)
    if Path(output).exists():
        raise ValueError("Recommendation artifacts are immutable; choose a fresh output directory.")
    manifests, vocabulary, summary = _prepare(source, min_support)
    output = _fresh(output, source)
    _write(output / "train.jsonl", manifests["train"], lines=True)
    _write(output / "validation.jsonl", manifests["validation"], lines=True)
    _write(output / "vocabulary.json", vocabulary)
    config = {"schema_version": 1, "min_train_support": min_support, "feature_dimension": _DIMENSION,
              "source_fingerprint_sha256": summary["source_fingerprint_sha256"], "target_policy": _POLICY}
    _write(output / "config.json", config)
    summary["artifact_sha256"] = {name: _sha(output / name) for name in ("train.jsonl", "validation.jsonl", "vocabulary.json", "config.json")}
    summary["manifest_sha256"] = hashlib.sha256(_json_bytes(summary["artifact_sha256"])).hexdigest()
    _write(output / "summary.json", summary)
    return summary


def _load_prepared(path: Path) -> tuple[dict, dict, dict]:
    path = private_output(Path(path))
    summary = json.loads((path / "summary.json").read_text(encoding="utf-8"))
    if summary.get("complete") is not True or summary.get("target_policy") != _POLICY or (path / "incomplete.json").exists():
        raise ValueError("Recommendation manifest is incomplete or incompatible.")
    expected = summary.get("artifact_sha256", {})
    names = {"train.jsonl", "validation.jsonl", "vocabulary.json", "config.json"}
    if set(expected) != names or hashlib.sha256(_json_bytes(expected)).hexdigest() != summary.get("manifest_sha256"):
        raise ValueError("Recommendation manifest digest is invalid.")
    for name in names:
        if _sha(path / name) != expected[name]:
            raise ValueError("Recommendation manifest artifact changed.")
    vocabulary = json.loads((path / "vocabulary.json").read_text(encoding="utf-8"))
    config = json.loads((path / "config.json").read_text(encoding="utf-8"))
    labels = vocabulary.get("labels")
    if (vocabulary.get("feature_dimension") != _DIMENSION or vocabulary.get("feature_policy") != "sha256-binary-profile-categories-v1"
            or vocabulary.get("target_policy") != _POLICY or not isinstance(labels, list) or not labels or len(labels) > _MAX_LABELS
            or any(not isinstance(label, str) or not label or len(label) > 256 for label in labels) or labels != sorted(set(labels))):
        raise ValueError("Recommendation vocabulary is invalid.")
    if (config.get("target_policy") != _POLICY or config.get("feature_dimension") != _DIMENSION
            or config.get("min_train_support") != summary.get("min_train_support")
            or config.get("source_fingerprint_sha256") != summary.get("source_fingerprint_sha256")
            or type(config.get("min_train_support")) is not int or config["min_train_support"] < 1
            or summary.get("label_count") != len(labels)):
        raise ValueError("Recommendation preparation config is invalid.")
    rows = {}
    ids = set()
    profiles = {}
    input_groups = {}
    for split in ("train", "validation"):
        rows[split] = []
        with (path / f"{split}.jsonl").open("rb") as stream:
            while True:
                line = stream.readline(_MAX_LINE + 1)
                if not line:
                    break
                if len(line) > _MAX_LINE or len(rows[split]) >= _MAX_ROWS:
                    raise ValueError("Recommendation manifest row limit exceeded.")
                row = json.loads(line)
                if set(row) != {"sample_id", "profile_sha256", "features", "targets"} or any(not isinstance(row[key], str) or not _DIGEST.fullmatch(row[key]) for key in ("sample_id", "profile_sha256")):
                    raise ValueError("Recommendation manifest row schema is invalid.")
                for key, maximum in (("features", _DIMENSION), ("targets", len(labels))):
                    values = row[key]
                    if not isinstance(values, list) or not values or any(type(value) is not int or not 0 <= value < maximum for value in values) or values != sorted(set(values)):
                        raise ValueError("Recommendation manifest indices are invalid.")
                if row["sample_id"] in ids:
                    raise ValueError("Recommendation manifest contains duplicate sample IDs.")
                ids.add(row["sample_id"])
                if row["profile_sha256"] in profiles and profiles[row["profile_sha256"]] != split:
                    raise ValueError("Recommendation profile overlaps publisher partitions.")
                profiles[row["profile_sha256"]] = split
                inputs = tuple(row["features"])
                if inputs in input_groups and input_groups[inputs] != split:
                    raise ValueError("Recommendation model inputs overlap publisher partitions.")
                input_groups[inputs] = split
                rows[split].append(row)
        if not rows[split]:
            raise ValueError("Recommendation manifest partition is empty.")
        if summary.get("partitions", {}).get(split, {}).get("usable_records") != len(rows[split]):
            raise ValueError("Recommendation manifest record count is inconsistent.")
    support = Counter(label for _profile, label in {(row["profile_sha256"], label) for row in rows["train"] for label in row["targets"]})
    if any(support[label] < config["min_train_support"] for label in range(len(labels))):
        raise ValueError("Recommendation labels do not meet recorded training support.")
    return rows, vocabulary, summary


def _device(torch, requested: str):
    if requested not in ("cpu", "cuda", "auto"):
        raise ValueError("Recommendation device must be cpu, cuda or auto.")
    if requested == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA is unavailable for recommendation research.")
    return torch.device("cuda" if requested == "cuda" or requested == "auto" and torch.cuda.is_available() else "cpu")


def _tensors(torch, rows: list[dict], label_count: int):
    x = torch.zeros((len(rows), _DIMENSION), dtype=torch.float32)
    y = torch.zeros((len(rows), label_count), dtype=torch.float32)
    for index, row in enumerate(rows):
        x[index, row["features"]] = 1
        y[index, row["targets"]] = 1
    return x, y


def _metrics(torch, scores, targets, frequent) -> dict:
    predicted = scores >= 0.5
    truth = targets.bool()
    tp = int((predicted & truth).sum())
    fp = int((predicted & ~truth).sum())
    fn = int((~predicted & truth).sum())
    k = min(5, targets.shape[1])
    top = scores.topk(k, dim=1).indices
    hits = truth.gather(1, top).sum(1).float()
    recall = hits / targets.sum(1).clamp_min(1)
    baseline_hits = truth[:, frequent].sum(1).float()
    return {"records": targets.shape[0], "micro_f1": 2 * tp / max(1, 2 * tp + fp + fn),
            "micro_precision": tp / max(1, tp + fp), "micro_recall": tp / max(1, tp + fn),
            "precision_at_5": float((hits / k).mean()), "recall_at_5": float(recall.mean()),
            "top_k": k, "frequent_baseline_precision_at_5": float((baseline_hits / k).mean()),
            "frequent_baseline_recall_at_5": float((baseline_hits / targets.sum(1).clamp_min(1)).mean())}


def _scores(torch, model, x, device, batch_size: int):
    model.eval()
    with torch.inference_mode():
        values = []
        for batch in x.split(batch_size):
            logits = model(batch.to(device))
            if not bool(torch.isfinite(logits).all()):
                raise ValueError("Recommendation model produced nonfinite scores.")
            scores = logits.sigmoid().cpu()
            values.append(scores)
        return torch.cat(values)


def _validate_training(epochs: int, batch_size: int, learning_rate: float, seed: int) -> None:
    if type(epochs) is not int or not 1 <= epochs <= 1000 or type(batch_size) is not int or not 1 <= batch_size <= 4096:
        raise ValueError("Recommendation epochs and batch size must be bounded positive integers.")
    if type(seed) is not int or not 0 <= seed < 2**32 or type(learning_rate) not in (int, float) or not math.isfinite(learning_rate) or not 0 < learning_rate <= 1:
        raise ValueError("Recommendation seed or learning rate is invalid.")


def train_recommendation(manifest_dir: Path, output_dir: Path, epochs: int = 20, batch_size: int = 64,
                         learning_rate: float = .01, seed: int = 42, device: str = "cpu") -> dict:
    _validate_training(epochs, batch_size, learning_rate, seed)
    manifest_dir = private_output(Path(manifest_dir))
    private_output(Path(output_dir), manifest_dir)
    if Path(output_dir).exists():
        raise ValueError("Recommendation artifacts are immutable; choose a fresh output directory.")
    rows, vocabulary, manifest_summary = _load_prepared(manifest_dir)
    import torch
    from torch import nn
    chosen = _device(torch, device)
    random.seed(seed)
    torch.manual_seed(seed)
    x, y = _tensors(torch, rows["train"], len(vocabulary["labels"]))
    vx, vy = _tensors(torch, rows["validation"], len(vocabulary["labels"]))
    positives = y.sum(0)
    if bool((positives == 0).any()):
        raise ValueError("Recommendation vocabulary contains an unsupported train label.")
    frequent = positives.argsort(descending=True, stable=True)[:min(5, y.shape[1])]
    pos_weight = ((len(y) - positives) / positives).clamp(min=1, max=50).to(chosen)
    model = nn.Linear(_DIMENSION, y.shape[1]).to(chosen)
    criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate, weight_decay=.01)
    generator = torch.Generator().manual_seed(seed)
    loader = torch.utils.data.DataLoader(torch.utils.data.TensorDataset(x, y), batch_size=batch_size, shuffle=True, generator=generator, num_workers=0)
    output = _fresh(output_dir, manifest_dir)
    config = {"schema_version": 1, "model": "structured-profile-linear-multilabel-v1", "feature_dimension": _DIMENSION,
              "label_count": y.shape[1], "manifest_sha256": manifest_summary["manifest_sha256"],
              "epochs": epochs, "batch_size": batch_size, "learning_rate": learning_rate, "seed": seed, "device": str(chosen),
              "selection_metric": "validation_micro_f1", "selection_tie_policy": "first", "threshold": .5,
              "positive_weight_max": 50, "target_policy": _POLICY, "candidate_prediction_only": True,
              "frequent_baseline_label_indices": frequent.tolist()}
    _write(output / "config.json", config)
    history = []
    best_score = -1.0
    best_epoch = 0
    previous_threads = torch.get_num_threads()
    torch.set_num_threads(min(4, previous_threads))
    try:
        for epoch in range(1, epochs + 1):
            model.train()
            total_loss = 0.0
            for bx, by in loader:
                bx, by = bx.to(chosen), by.to(chosen)
                optimizer.zero_grad(set_to_none=True)
                loss = criterion(model(bx), by)
                if not bool(torch.isfinite(loss)):
                    raise ValueError("Recommendation training produced a nonfinite loss.")
                loss.backward()
                optimizer.step()
                total_loss += float(loss.detach()) * len(bx)
            validation = _metrics(torch, _scores(torch, model, vx, chosen, batch_size), vy, frequent)
            history.append({"epoch": epoch, "train_mean_loss": total_loss / len(x), "validation": validation})
            if validation["micro_f1"] > best_score:
                best_score, best_epoch = validation["micro_f1"], epoch
                torch.save({key: value.detach().cpu() for key, value in model.state_dict().items()}, output / "checkpoint-best.pt")
                (output / "checkpoint-best.pt").chmod(0o600)
        torch.save({key: value.detach().cpu() for key, value in model.state_dict().items()}, output / "checkpoint-last.pt")
        (output / "checkpoint-last.pt").chmod(0o600)
        result = {"schema_version": 1, "complete": True, "candidate_prediction_only": True, "unreviewed_silver_labels": True,
                  "best_epoch": best_epoch, "selection_metric": "validation_micro_f1", "best_validation": history[best_epoch - 1]["validation"],
                  "history": history, "train_records": len(x), "validation_records": len(vx), "label_count": y.shape[1],
                  "manifest_sha256": manifest_summary["manifest_sha256"], "limitations": manifest_summary["limitations"]}
        _write(output / "metrics.json", result)
        _write(output / "artifacts.json", {"schema_version": 1, "complete": True, "sha256": {name: _sha(output / name) for name in ("config.json", "metrics.json", "checkpoint-best.pt", "checkpoint-last.pt")}})
        return result
    except Exception:
        _write(output / "incomplete.json", {"complete": False, "error": "Recommendation training did not complete."})
        raise
    finally:
        torch.set_num_threads(previous_threads)


def evaluate_recommendation(manifest_dir: Path, run_dir: Path, checkpoint: str = "best", device: str = "cpu", batch_size: int = 64) -> dict:
    _validate_training(1, batch_size, .01, 42)
    if checkpoint not in ("best", "last"):
        raise ValueError("Recommendation checkpoint must be best or last.")
    manifest_dir, run_dir = private_output(Path(manifest_dir)), private_output(Path(run_dir))
    rows, vocabulary, manifest_summary = _load_prepared(manifest_dir)
    if (run_dir / "incomplete.json").exists():
        raise ValueError("Recommendation training run is incomplete.")
    artifacts = json.loads((run_dir / "artifacts.json").read_text(encoding="utf-8"))
    names = {"config.json", "metrics.json", "checkpoint-best.pt", "checkpoint-last.pt"}
    if artifacts.get("complete") is not True or set(artifacts.get("sha256", {})) != names:
        raise ValueError("Recommendation run artifact list is invalid.")
    for name in names:
        if _sha(run_dir / name) != artifacts["sha256"][name]:
            raise ValueError("Recommendation run artifact changed.")
    config = json.loads((run_dir / "config.json").read_text(encoding="utf-8"))
    if (config.get("manifest_sha256") != manifest_summary["manifest_sha256"] or config.get("feature_dimension") != _DIMENSION
            or config.get("label_count") != len(vocabulary["labels"]) or config.get("model") != "structured-profile-linear-multilabel-v1"
            or config.get("target_policy") != _POLICY or config.get("threshold") != .5
            or config.get("selection_metric") != "validation_micro_f1" or config.get("selection_tie_policy") != "first"):
        raise ValueError("Recommendation run and manifest do not match.")
    _validate_training(config.get("epochs"), config.get("batch_size"), config.get("learning_rate"), config.get("seed"))
    recorded = json.loads((run_dir / "metrics.json").read_text(encoding="utf-8"))
    history = recorded.get("history")
    if (recorded.get("complete") is not True or recorded.get("manifest_sha256") != manifest_summary["manifest_sha256"]
            or recorded.get("train_records") != len(rows["train"]) or recorded.get("validation_records") != len(rows["validation"])
            or recorded.get("label_count") != len(vocabulary["labels"]) or not isinstance(history, list) or len(history) != config["epochs"]):
        raise ValueError("Recommendation recorded metrics are invalid.")
    for epoch, entry in enumerate(history, 1):
        if (entry.get("epoch") != epoch or not isinstance(entry.get("train_mean_loss"), (int, float))
                or not math.isfinite(entry["train_mean_loss"]) or entry["train_mean_loss"] < 0
                or not isinstance(entry.get("validation"), dict) or entry["validation"].get("records") != len(rows["validation"])
                or any(not isinstance(entry["validation"].get(key), (int, float)) or not 0 <= entry["validation"][key] <= 1
                       for key in ("micro_f1", "micro_precision", "micro_recall", "precision_at_5", "recall_at_5", "frequent_baseline_precision_at_5", "frequent_baseline_recall_at_5"))):
            raise ValueError("Recommendation epoch metrics are invalid.")
    best_index = max(range(len(history)), key=lambda index: history[index]["validation"]["micro_f1"])
    if recorded.get("best_epoch") != best_index + 1 or recorded.get("best_validation") != history[best_index]["validation"]:
        raise ValueError("Recommendation best-checkpoint selection is inconsistent.")
    import torch
    from torch import nn
    chosen = _device(torch, device)
    state = torch.load(run_dir / f"checkpoint-{checkpoint}.pt", map_location="cpu", weights_only=True)
    if not isinstance(state, dict) or set(state) != {"weight", "bias"} or any(not isinstance(value, torch.Tensor) or not bool(torch.isfinite(value).all()) for value in state.values()):
        raise ValueError("Recommendation checkpoint must contain finite tensors only.")
    if tuple(state["weight"].shape) != (len(vocabulary["labels"]), _DIMENSION) or tuple(state["bias"].shape) != (len(vocabulary["labels"]),):
        raise ValueError("Recommendation checkpoint tensor shapes are invalid.")
    model = nn.Linear(_DIMENSION, len(vocabulary["labels"])).to(chosen)
    model.load_state_dict(state)
    vx, vy = _tensors(torch, rows["validation"], len(vocabulary["labels"]))
    frequent = config.get("frequent_baseline_label_indices")
    if not isinstance(frequent, list) or len(frequent) != min(5, len(vocabulary["labels"])) or any(type(value) is not int or not 0 <= value < len(vocabulary["labels"]) for value in frequent):
        raise ValueError("Recommendation baseline indices are invalid.")
    supports = [0] * len(vocabulary["labels"])
    for row in rows["train"]:
        for label in row["targets"]:
            supports[label] += 1
    expected_frequent = sorted(range(len(supports)), key=lambda label: (-supports[label], label))[:min(5, len(supports))]
    if frequent != expected_frequent:
        raise ValueError("Recommendation baseline does not match training-only support.")
    validation = _metrics(torch, _scores(torch, model, vx, chosen, batch_size), vy, frequent)
    reference = history[best_index if checkpoint == "best" else -1]["validation"]
    difference = max(abs(validation[key] - reference[key]) for key in validation)
    result = {"schema_version": 1, "candidate_prediction_only": True, "unreviewed_silver_labels": True,
              "checkpoint": checkpoint, "checkpoint_sha256": artifacts["sha256"][f"checkpoint-{checkpoint}.pt"],
              "manifest_sha256": manifest_summary["manifest_sha256"], "validation": validation,
              "recorded_metrics_match": difference <= 1e-6, "maximum_recorded_metric_difference": difference,
              "limitations": manifest_summary["limitations"]}
    evaluation = run_dir / "evaluations" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex)
    evaluation.parent.mkdir(mode=0o700, exist_ok=True)
    evaluation.mkdir(mode=0o700)
    _write(evaluation / "summary.json", result)
    return result
