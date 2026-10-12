"""Synthetic categorical interoperability; no source photos or trained models."""

import copy
import hashlib
import itertools
import json
from pathlib import Path

import pytest

from senmiva_training import recommendation as training
from senmiva_training import skin_code_contract as contract
from test_recommendation import record, workbook, write_records


BASE_CODES = dict(zip(contract.TARGET_ORDER, ("NS", "P1", "W1", "NA", "VP", "SA", "ND", "NR")))
BASE_CONDITION = "/".join(BASE_CODES.values())
OTHER_CONDITION = "S/P2/W2/A/NVP/NSA/D/R"
VALIDATION_CONDITION = "S/P0/W0/NA/NVP/NSA/ND/NR"


@pytest.fixture
def prepared(tmp_path):
    source, manifest, output = tmp_path / "source", tmp_path / "manifest", tmp_path / "contracts" / "codes.json"
    workbook(source / "ingredients.xlsx")
    values = [record(1, "Niacinamide recommended.", condition=BASE_CONDITION),
              record(2, "Panthenol recommended.", condition=OTHER_CONDITION)]
    extra = record(3, "Niacinamide and Panthenol recommended.", condition=BASE_CONDITION)
    extra["meta"]["age"] = 54
    values.append(extra)
    write_records(source, values, [record(101, "Niacinamide recommended.", condition=VALIDATION_CONDITION)])
    training.prepare_recommendation(source, manifest, min_support=1)
    return source, manifest, output


def load(output, manifest):
    rows, _, summary = training._load_prepared(manifest)
    return contract.load_condition_support(output, rows, summary)


def reseal(output):
    artifact = json.loads(output.read_text(encoding="utf-8"))
    body = {key: value for key, value in artifact.items() if key != "sha256"}
    artifact["sha256"] = hashlib.sha256(training._json_bytes(body)).hexdigest()
    output.write_text(json.dumps(artifact), encoding="utf-8")


def test_exact_original_whole_category_and_order():
    expected = training._category(BASE_CONDITION, "initial_skin_condition")
    assert contract.visual_condition_token(dict(reversed(list(BASE_CODES.items())))) == expected
    assert expected == "initial_skin_condition=ns/p1/w1/na/vp/sa/nd/nr"
    assert contract.CONTRACT_VERSION == "aihub71886-source-codes-v1"


@pytest.mark.parametrize("mutation", ["missing", "extra", "unknown", "lowercase", "wrong_head", "none", "scalar"])
def test_visual_mapping_rejects_ambiguous_or_incomplete_schema(mutation):
    codes = dict(BASE_CODES)
    if mutation == "missing":
        codes.pop("acne")
    elif mutation == "extra":
        codes["private_field"] = "private_value"
    elif mutation == "unknown":
        codes["acne"] = "UNKNOWN"
    elif mutation == "lowercase":
        codes["acne"] = "na"
    elif mutation == "wrong_head":
        codes["acne"] = "NS"
    elif mutation == "none":
        codes["acne"] = None
    else:
        codes = "private input"
    with pytest.raises(ValueError) as error:
        contract.visual_condition_token(codes)
    assert "private" not in str(error.value)


def test_builds_train_only_provenance_and_changes_no_existing_bytes(prepared):
    source, manifest, output = prepared
    before = {path: path.read_bytes() for root in (source, manifest) for path in root.rglob("*") if path.is_file()}
    public = contract.build_condition_support(source, manifest, output)
    assert public["condition_count"] == 2
    assert public["retained_train_profile_count"] == 3
    assert public["source_records_audited"] == 4
    assert public["clinical_semantics_verified"] is False
    assert public["image_annotation_linkage_verified"] is False
    assert load(output, manifest) == frozenset((training._category(BASE_CONDITION, "initial_skin_condition"),
                                               training._category(OTHER_CONDITION, "initial_skin_condition")))
    artifact = json.loads(output.read_text(encoding="utf-8"))
    assert len(artifact["witnesses"]) == 2
    assert "private-" not in output.read_text(encoding="utf-8")
    for forbidden in (str(source), str(manifest), "feature_tokens", "profile_sha256", "age_bucket", "gender="):
        assert forbidden not in json.dumps(public)
    assert before == {path: path.read_bytes() for root in (source, manifest) for path in root.rglob("*") if path.is_file()}
    original = output.read_bytes()
    with pytest.raises(ValueError, match="could not be verified"):
        contract.build_condition_support(source, manifest, output)
    assert output.read_bytes() == original


def test_runtime_support_loading_never_reopens_source(prepared, monkeypatch):
    source, manifest, output = prepared
    contract.build_condition_support(source, manifest, output)
    original = Path.open
    def open_without_source(self, *args, **kwargs):
        assert not self.is_relative_to(source), "Runtime must not open source data."
        return original(self, *args, **kwargs)
    monkeypatch.setattr(Path, "open", open_without_source)
    assert len(load(output, manifest)) == 2


@pytest.mark.parametrize("mutation", ["digest", "version", "manifest", "fingerprint", "order", "domains", "claim", "extra", "bool_version",
                                       "condition", "witness_tokens", "witness_profile", "validation_witness", "duplicate", "too_many"])
def test_tampered_even_resealed_artifact_cannot_authorize_new_condition(prepared, mutation):
    source, manifest, output = prepared
    contract.build_condition_support(source, manifest, output)
    artifact = json.loads(output.read_text(encoding="utf-8"))
    witness = artifact["witnesses"][0]
    if mutation == "digest":
        artifact["sha256"] = "0" * 64
    elif mutation == "version":
        artifact["contract_version"] = "unsupported"
    elif mutation == "manifest":
        artifact["manifest_sha256"] = "0" * 64
    elif mutation == "fingerprint":
        artifact["source_fingerprint_sha256"] = "0" * 64
    elif mutation == "order":
        artifact["target_order"] = list(reversed(artifact["target_order"]))
    elif mutation == "domains":
        artifact["code_domains"]["acne"] = ["A", "NA", "UNKNOWN"]
    elif mutation == "claim":
        artifact["clinical_semantics_verified"] = True
    elif mutation == "extra":
        artifact["extra"] = "private field"
    elif mutation == "bool_version":
        artifact["schema_version"] = True
    elif mutation == "condition":
        witness["condition_token"] = training._category(VALIDATION_CONDITION, "initial_skin_condition")
    elif mutation == "witness_tokens":
        witness["feature_tokens"][0] = "private input"
    elif mutation == "witness_profile":
        witness["profile_sha256"] = "f" * 64
    elif mutation == "validation_witness":
        tokens = training._feature_tokens(record(101, "Niacinamide recommended.", condition=VALIDATION_CONDITION))
        witness.update({"feature_tokens": list(tokens), "profile_sha256": hashlib.sha256(training._json_bytes(tokens)).hexdigest(),
                        "condition_token": training._category(VALIDATION_CONDITION, "initial_skin_condition")})
    elif mutation == "duplicate":
        artifact["witnesses"].append(copy.deepcopy(witness))
    else:
        artifact["witnesses"] = [copy.deepcopy(witness)] * 577
    output.write_text(json.dumps(artifact), encoding="utf-8")
    if mutation != "digest":
        reseal(output)
    with pytest.raises(ValueError, match="could not be verified") as error:
        load(output, manifest)
    assert str(source) not in str(error.value) and "private input" not in str(error.value)


@pytest.mark.parametrize("target", ["jsonl", "workbook", "missing_train", "invalid_source_code"])
def test_source_change_or_incomplete_train_coverage_refuses_output(prepared, target):
    source, manifest, output = prepared
    if target == "workbook":
        with (source / "ingredients.xlsx").open("ab") as stream:
            stream.write(b"changed")
    else:
        path = source / "TL_annotations" / "synthetic.jsonl"
        rows = path.read_text(encoding="utf-8").splitlines()
        if target == "jsonl":
            rows[0] += " "
        elif target == "missing_train":
            rows.pop(0)
        else:
            row = json.loads(rows[0])
            row["meta"]["initial_skin_condition"] = "NS/P1/W1/NA/VP/SA/ND/UNKNOWN"
            rows[0] = json.dumps(row)
        path.write_text("\n".join(rows) + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="could not be verified"):
        contract.build_condition_support(source, manifest, output)
    assert not output.exists()


def test_witness_must_match_exact_prepared_feature_vector(prepared):
    source, manifest, output = prepared
    contract.build_condition_support(source, manifest, output)
    rows, _, summary = training._load_prepared(manifest)
    for row in rows["train"]:
        row["features"] = [999]
    with pytest.raises(ValueError, match="could not be verified"):
        contract.load_condition_support(output, rows, summary)


@pytest.mark.parametrize("kind", ["oversize", "missing", "malformed"])
def test_invalid_private_artifact_is_generic(prepared, kind):
    _, manifest, output = prepared
    output.parent.mkdir()
    if kind == "oversize":
        output.write_bytes(b" " * (4 * 1024 * 1024 + 1))
    elif kind == "malformed":
        output.write_text("private malformed contents")
    with pytest.raises(ValueError, match="could not be verified"):
        load(output, manifest)


def test_output_must_be_outside_source_and_existing_manifest(prepared):
    source, manifest, _ = prepared
    for output in (source / "derived.json", manifest / "derived.json"):
        with pytest.raises(ValueError, match="could not be verified"):
            contract.build_condition_support(source, manifest, output)
        assert not output.exists()


def test_artifact_created_during_source_scan_is_never_overwritten(prepared, monkeypatch):
    source, manifest, output = prepared
    original = training._sha
    def create_competing_artifact(path):
        result = original(path)
        if path.suffix == ".xlsx":
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"existing competing private artifact")
        return result
    monkeypatch.setattr(training, "_sha", create_competing_artifact)
    with pytest.raises(ValueError, match="could not be verified"):
        contract.build_condition_support(source, manifest, output)
    assert output.read_bytes() == b"existing competing private artifact"


def test_hash_collision_cannot_replace_a_proven_training_category(tmp_path):
    # A feature-index allowlist alone would accept this unseen whole condition.
    # The retained profile witness must reject it even after a self-digest seal.
    seen = {}
    collision = None
    for codes in itertools.product(*(contract.TARGETS[key] for key in contract.TARGET_ORDER)):
        condition = "/".join(codes)
        token = training._category(condition, "initial_skin_condition")
        index = training._feature_indices((token,))[0]
        if index in seen:
            collision = (seen[index], condition)
            break
        seen[index] = condition
    assert collision is not None
    trained, unseen = collision
    source, manifest, output = tmp_path / "source", tmp_path / "manifest", tmp_path / "contracts" / "codes.json"
    workbook(source / "ingredients.xlsx")
    train_row = record(1, "Niacinamide recommended.", condition=trained)
    validation_row = record(101, "Niacinamide recommended.", condition=unseen)
    validation_row["meta"]["age"] = 54
    write_records(source, [train_row], [validation_row])
    training.prepare_recommendation(source, manifest, min_support=1)
    contract.build_condition_support(source, manifest, output)
    artifact = json.loads(output.read_text(encoding="utf-8"))
    witness = artifact["witnesses"][0]
    unseen_tokens = training._feature_tokens({**train_row, "meta": {**train_row["meta"], "initial_skin_condition": unseen}})
    assert training._feature_indices(tuple(witness["feature_tokens"])) == training._feature_indices(unseen_tokens)
    witness.update({"condition_token": training._category(unseen, "initial_skin_condition"),
                    "feature_tokens": list(unseen_tokens),
                    "profile_sha256": hashlib.sha256(training._json_bytes(unseen_tokens)).hexdigest()})
    output.write_text(json.dumps(artifact), encoding="utf-8")
    reseal(output)
    with pytest.raises(ValueError, match="could not be verified"):
        load(output, manifest)
