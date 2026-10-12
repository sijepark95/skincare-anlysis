"""Synthetic structured-profile candidate model fixtures; no licensed records."""

import copy
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

import pytest

from senmiva_training import recommendation as rec
from senmiva_training.recommendation import prepare_recommendation, train_recommendation, evaluate_recommendation


LABELS = [("Niacinamide", "나이아신아마이드"), ("Panthenol", "판테놀"), ("Salicylic Acid", "살리실산"), ("Unknown Ingredient", "미확인성분")]


def workbook(path: Path, rows=LABELS, headers=("성분명(INCI)", "한글명 ")) -> None:
    ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    root = ET.Element(f"{{{ns}}}worksheet")
    data = ET.SubElement(root, f"{{{ns}}}sheetData")
    for index, values in enumerate([headers, *rows], 1):
        row = ET.SubElement(data, f"{{{ns}}}row", r=str(index))
        for column, value in zip(("A", "B"), values):
            cell = ET.SubElement(row, f"{{{ns}}}c", r=f"{column}{index}", t="inlineStr")
            inline = ET.SubElement(cell, f"{{{ns}}}is")
            ET.SubElement(inline, f"{{{ns}}}t").text = value
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("xl/worksheets/sheet1.xml", ET.tostring(root))


def record(number: int, answer: str, *, group: str | None = None, condition: str | None = None) -> dict:
    return {"info": {"id": f"private-record-{number}", "source_survey_id": group or f"private-survey-{number}",
                     "answer": answer, "question": "private-question", "target_concern": "private-target", "evidence_sources": ["private-evidence"]},
            "meta": {"age": 34, "gender": "여성", "skin_type": "복합성", "initial_skin_condition": condition or f"code-{number}",
                     "skin_concerns": ["모공", "건조"], "image_filename": "private-image.jpg"},
            "external": [{"priority": 1, "factor": "계절", "details": "private-details"}],
            "chain_of_thought": [{"content": "private-reasoning"}]}


def write_records(source: Path, train: list[dict], validation: list[dict]) -> None:
    for prefix, rows in (("TL", train), ("VL", validation)):
        path = source / f"{prefix}_annotations" / "synthetic.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


@pytest.fixture
def source(tmp_path: Path) -> Path:
    source = tmp_path / "source"
    workbook(source / "ingredients.xlsx")
    write_records(source, [record(1, "나이아신아마이드를 추천합니다."), record(2, "판테놀을 추천합니다."),
                           record(3, "Niacinamide and Panthenol are candidates.")],
                          [record(101, "나이아신아마이드 추천"), record(102, "판테놀 추천")])
    return source


def read_rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def reseal_manifest(path: Path) -> None:
    summary = json.loads((path / "summary.json").read_text())
    summary["artifact_sha256"] = {name: rec._sha(path / name) for name in summary["artifact_sha256"]}
    summary["manifest_sha256"] = hashlib.sha256(rec._json_bytes(summary["artifact_sha256"])).hexdigest()
    (path / "summary.json").write_text(json.dumps(summary), encoding="utf-8")


def reseal_run(path: Path) -> None:
    artifacts = json.loads((path / "artifacts.json").read_text())
    artifacts["sha256"] = {name: rec._sha(path / name) for name in artifacts["sha256"]}
    (path / "artifacts.json").write_text(json.dumps(artifacts))


def test_prepare_uses_only_structured_features_and_private_salted_rows(source: Path, tmp_path: Path) -> None:
    before = {file: file.read_bytes() for file in source.rglob("*") if file.is_file()}
    first = tmp_path / "prepared"
    summary = prepare_recommendation(source, first, min_support=1)
    assert summary["label_count"] == 2
    assert summary["partitions"]["train"]["usable_records"] == 3
    assert summary["partitions"]["validation"]["usable_records"] == 2
    assert summary["candidate_prediction_only"] and summary["unreviewed_silver_labels"]
    rows = read_rows(first / "train.jsonl")
    assert all(set(row) == {"sample_id", "profile_sha256", "features", "targets"} for row in rows)
    assert all(0 <= feature < 2048 for row in rows for feature in row["features"])
    assert json.loads((first / "vocabulary.json").read_text())["labels"] == ["Niacinamide", "Panthenol"]
    public_and_manifest = json.dumps(summary) + (first / "train.jsonl").read_text()
    for private in ("private-survey", "private-record", "private-question", "private-target", "private-image", "private-details", "private-reasoning", "private-evidence", str(source), "나이아신아마이드"):
        assert private not in public_and_manifest
    assert before == {file: file.read_bytes() for file in source.rglob("*") if file.is_file()}
    second = tmp_path / "prepared-again"
    prepare_recommendation(source, second, min_support=1)
    assert {row["sample_id"] for row in rows}.isdisjoint(row["sample_id"] for row in read_rows(second / "train.jsonl"))
    assert rec._load_prepared(first)[2] == summary


def test_text_identifiers_and_annotation_fields_never_enter_features() -> None:
    original = record(1, "판테놀 추천")
    modified = copy.deepcopy(original)
    modified["info"] = {"id": "different-id", "source_survey_id": "different-survey", "answer": "살리실산 피하세요", "question": "different-question", "target_concern": "different-target", "evidence_sources": ["different-evidence"]}
    modified["meta"]["image_filename"] = "different.jpg"
    modified["external"][0]["details"] = "different external description"
    modified["external"][0]["priority"] = 99
    modified["chain_of_thought"] = "different-reasoning"
    assert rec._feature_tokens(original) == rec._feature_tokens(modified)
    assert rec._feature_indices(rec._feature_tokens(original)) == rec._feature_indices(rec._feature_tokens(modified))


@pytest.mark.parametrize("answer", ["나이아신아마이드를 추천하지 않습니다.", "나이아신아마이드 추천되지 않습니다.",
                                   "나이아신아마이드는 권장되지 않습니다.", "나이아신아마이드 추천 하지 않습니다.",
                                   "나이아신아마이드를 사용하면 안 됩니다.", "나이아신아마이드는 적합하지 않습니다.",
                                   "Niacinamide is not suitable.", "You should not use Niacinamide.", "Avoid Niacinamide.",
                                   "나이아신아마이드와 판테놀은 피하세요."])
def test_explicit_negative_sentences_are_not_positive_targets(answer: str) -> None:
    aliases = {"나이아신아마이드": "Niacinamide", "niacinamide": "Niacinamide", "판테놀": "Panthenol"}
    assert rec._targets(answer, aliases, rec._matcher(aliases)) == set()


def test_negative_paragraph_does_not_drop_separate_positive_paragraph() -> None:
    aliases = {"niacinamide": "Niacinamide", "판테놀": "Panthenol"}
    assert rec._targets("Niacinamide is recommended.\n판테놀은 피하세요.", aliases, rec._matcher(aliases)) == {"Niacinamide"}


@pytest.mark.parametrize("answer", ["아세틸살리실산 추천", "살리실산나트륨 추천", "피토세라마이드 추천", "XNiacinamide", "NiacinamideX"])
def test_compound_and_substring_aliases_do_not_imply_parent_ingredients(answer: str) -> None:
    aliases = {"살리실산": "Salicylic Acid", "세라마이드": "Ceramide", "niacinamide": "Niacinamide"}
    assert rec._targets(answer, aliases, rec._matcher(aliases)) == set()


def test_longest_match_and_controlled_korean_particles() -> None:
    aliases = {"살리실산": "Salicylic Acid", "살리실산나트륨": "Sodium Salicylate", "판테놀": "Panthenol"}
    assert rec._targets("살리실산나트륨과 판테놀을 추천합니다.", aliases, rec._matcher(aliases)) == {"Sodium Salicylate", "Panthenol"}


def test_ambiguous_workbook_alias_is_dropped(tmp_path: Path) -> None:
    path = tmp_path / "ingredients.xlsx"
    workbook(path, [("Ingredient A", "중복명"), ("Ingredient B", "중복명")])
    aliases, summary = rec._ingredient_dictionary(path)
    assert "중복명" not in aliases
    assert summary["ambiguous_aliases_excluded"] == 1
    assert rec._targets("중복명 추천", aliases, rec._matcher(aliases)) == set()


def test_source_survey_and_exact_profile_overlap_are_excluded_from_both_partitions(source: Path, tmp_path: Path) -> None:
    train = [record(1, "판테놀 추천", group="same-survey"), record(2, "판테놀 추천"), record(3, "판테놀 추천")]
    validation = [record(101, "판테놀 추천", group="same-survey"), record(102, "판테놀 추천", condition="code-2"), record(103, "판테놀 추천")]
    write_records(source, train, validation)
    summary = prepare_recommendation(source, tmp_path / "prepared", min_support=1)
    assert summary["shared_source_survey_groups_excluded"] == 1
    assert summary["shared_exact_profile_groups_excluded"] == 1
    assert summary["partitions"]["train"]["cross_partition_excluded"] == 2
    assert summary["partitions"]["validation"]["cross_partition_excluded"] == 2
    assert summary["partitions"]["train"]["usable_records"] == 1
    assert summary["partitions"]["validation"]["usable_records"] == 1


def test_hash_input_overlap_guard_is_conservative(source: Path, tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(rec, "_feature_indices", lambda _tokens: [1])
    with pytest.raises(ValueError, match="No ingredient labels"):
        prepare_recommendation(source, tmp_path / "prepared", min_support=1)
    assert not (tmp_path / "prepared").exists()


def test_support_is_fit_on_distinct_training_profiles_only_and_unknown_validation_is_reported(source: Path, tmp_path: Path) -> None:
    write_records(source, [record(1, "판테놀 추천"), record(2, "판테놀과 나이아신아마이드 추천"), record(3, "살리실산 추천")],
                          [record(101, "판테놀과 미확인성분 추천"), record(102, "미확인성분 추천")])
    output = tmp_path / "prepared"
    summary = prepare_recommendation(source, output, min_support=2)
    assert json.loads((output / "vocabulary.json").read_text())["labels"] == ["Panthenol"]
    assert summary["partitions"]["validation"]["positive_mentions_outside_train_vocabulary"] == 2
    assert summary["partitions"]["validation"]["no_supported_positive_targets"] == 1
    assert summary["partitions"]["train"]["no_supported_positive_targets"] == 1


def test_repeated_profile_does_not_inflate_minimum_support(source: Path, tmp_path: Path) -> None:
    write_records(source, [record(1, "판테놀 추천"), record(2, "판테놀과 살리실산 추천", condition="code-1")], [record(101, "판테놀 추천")])
    with pytest.raises(ValueError, match="No ingredient labels"):
        prepare_recommendation(source, tmp_path / "prepared", min_support=2)


def test_post_filter_duplicate_and_no_match_rows_are_not_negative_training_examples(source: Path, tmp_path: Path) -> None:
    write_records(source, [record(1, "판테놀 추천"), record(2, "판테놀과 살리실산 추천", condition="code-1"),
                           record(3, "판테놀 추천"), record(4, "성분이 없습니다.")], [record(101, "판테놀 추천")])
    summary = prepare_recommendation(source, tmp_path / "prepared", min_support=2)
    assert summary["partitions"]["train"]["duplicates_after_label_filter"] == 1
    assert summary["partitions"]["train"]["no_positive_ingredient_match"] == 1
    assert summary["partitions"]["train"]["usable_records"] == 2


@pytest.mark.parametrize("change", [lambda r: r.pop("meta"), lambda r: r["meta"].update(age="34"),
                                   lambda r: r["meta"].update(skin_concerns="모공"), lambda r: r["info"].pop("answer"),
                                   lambda r: r["info"].update(source_survey_id=""), lambda r: r["external"].append("invalid")])
def test_malformed_schemas_fail_without_writing(source: Path, tmp_path: Path, change) -> None:
    bad = record(1, "판테놀 추천")
    change(bad)
    write_records(source, [bad], [record(101, "판테놀 추천")])
    with pytest.raises(ValueError):
        prepare_recommendation(source, tmp_path / "prepared", min_support=1)
    assert not (tmp_path / "prepared").exists()


def test_workbook_required_headers_and_xml_entity_safety(tmp_path: Path) -> None:
    path = tmp_path / "workbook.xlsx"
    workbook(path, headers=("wrong", "한글명"))
    with pytest.raises(ValueError, match="missing INCI"):
        rec._ingredient_dictionary(path)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("xl/worksheets/sheet1.xml", b'<!DOCTYPE r [<!ENTITY x "payload">]><r>&x;</r>')
    with pytest.raises(ValueError, match="Unsafe"):
        rec._ingredient_dictionary(path)


def test_conflicting_source_partitions_and_incomplete_extractions_are_rejected(source: Path, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="conflict"):
        rec._partition(source / "TL_source/VL_source/file.jsonl", source)
    (source / "incomplete.json").write_text('{"complete":false}')
    with pytest.raises(ValueError, match="incomplete"):
        prepare_recommendation(source, tmp_path / "prepared", min_support=1)


def test_private_output_and_immutable_manifest_policy(source: Path, tmp_path: Path) -> None:
    output = tmp_path / "prepared"
    prepare_recommendation(source, output, min_support=1)
    before = rec._sha(output / "train.jsonl")
    with pytest.raises(ValueError, match="immutable"):
        prepare_recommendation(source, output, min_support=1)
    assert rec._sha(output / "train.jsonl") == before
    for output in (source / "prepared", tmp_path / "OneDrive/prepared", source.parent):
        with pytest.raises(ValueError):
            prepare_recommendation(source, output, min_support=1)


def test_modified_manifest_bytes_are_rejected_before_training(source: Path, tmp_path: Path) -> None:
    output = tmp_path / "prepared"
    prepare_recommendation(source, output, min_support=1)
    with (output / "train.jsonl").open("a") as stream:
        stream.write("{}\n")
    with pytest.raises(ValueError, match="artifact changed"):
        train_recommendation(output, tmp_path / "run", epochs=1)
    assert not (tmp_path / "run").exists()


@pytest.mark.parametrize("mutation", ["duplicate", "overlap", "support", "policy"])
def test_resealed_but_invalid_manifest_structure_is_rejected(source: Path, tmp_path: Path, mutation: str) -> None:
    output = tmp_path / "prepared"
    prepare_recommendation(source, output, min_support=1)
    if mutation == "duplicate":
        rows = read_rows(output / "train.jsonl")
        rows[1]["sample_id"] = rows[0]["sample_id"]
        (output / "train.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))
    elif mutation == "overlap":
        train, validation = read_rows(output / "train.jsonl"), read_rows(output / "validation.jsonl")
        validation[0]["profile_sha256"] = train[0]["profile_sha256"]
        (output / "validation.jsonl").write_text("".join(json.dumps(row) + "\n" for row in validation))
    elif mutation == "support":
        config = json.loads((output / "config.json").read_text())
        config["min_train_support"] = 100
        (output / "config.json").write_text(json.dumps(config))
        summary = json.loads((output / "summary.json").read_text())
        summary["min_train_support"] = 100
        (output / "summary.json").write_text(json.dumps(summary))
    else:
        vocabulary = json.loads((output / "vocabulary.json").read_text())
        vocabulary["target_policy"] = "different"
        (output / "vocabulary.json").write_text(json.dumps(vocabulary))
    reseal_manifest(output)
    with pytest.raises(ValueError):
        rec._load_prepared(output)


def test_small_explicit_cpu_training_and_saved_checkpoint_evaluation_are_aggregate_only(source: Path, tmp_path: Path, monkeypatch) -> None:
    torch = pytest.importorskip("torch")
    prepared, run = tmp_path / "prepared", tmp_path / "run"
    prepare_recommendation(source, prepared, min_support=1)
    result = train_recommendation(prepared, run, epochs=2, batch_size=2)
    assert result["complete"] is True and result["train_records"] == 3
    assert result["validation_records"] == 2 and len(result["history"]) == 2
    assert "private-" not in json.dumps(result)
    before = {name: rec._sha(run / name) for name in ("config.json", "metrics.json", "checkpoint-best.pt", "checkpoint-last.pt")}
    real_load = torch.load
    load_arguments = []
    def record_load(*args, **kwargs):
        load_arguments.append(kwargs)
        return real_load(*args, **kwargs)
    monkeypatch.setattr(torch, "load", record_load)
    def prohibit_training(*_args, **_kwargs):
        raise AssertionError("Evaluation must not train")
    monkeypatch.setattr(torch.optim.AdamW, "step", prohibit_training)
    best = evaluate_recommendation(prepared, run, batch_size=1)
    last = evaluate_recommendation(prepared, run, checkpoint="last", batch_size=2)
    assert best["recorded_metrics_match"] and last["recorded_metrics_match"]
    assert best["validation"] == result["best_validation"]
    assert all(arguments["weights_only"] is True for arguments in load_arguments)
    assert before == {name: rec._sha(run / name) for name in before}
    assert len(list((run / "evaluations").glob("*/summary.json"))) == 2
    with pytest.raises(ValueError, match="immutable"):
        train_recommendation(prepared, run, epochs=1)
    (run / "checkpoint-best.pt").write_bytes(b"changed")
    with pytest.raises(ValueError, match="artifact changed"):
        evaluate_recommendation(prepared, run)


@pytest.mark.parametrize("mutation", ["model", "best_epoch", "baseline", "history"])
def test_resealed_run_semantics_are_validated_before_evaluation(source: Path, tmp_path: Path, mutation: str) -> None:
    pytest.importorskip("torch")
    prepared, run = tmp_path / "prepared", tmp_path / "run"
    prepare_recommendation(source, prepared, min_support=1)
    train_recommendation(prepared, run, epochs=1, batch_size=2)
    if mutation in ("model", "baseline"):
        config = json.loads((run / "config.json").read_text())
        config["model" if mutation == "model" else "frequent_baseline_label_indices"] = "wrong" if mutation == "model" else [0, 0]
        (run / "config.json").write_text(json.dumps(config))
    else:
        metrics = json.loads((run / "metrics.json").read_text())
        if mutation == "best_epoch":
            metrics["best_epoch"] = 10
        else:
            metrics["history"][0]["train_mean_loss"] = -1
        (run / "metrics.json").write_text(json.dumps(metrics))
    reseal_run(run)
    with pytest.raises(ValueError):
        evaluate_recommendation(prepared, run)


@pytest.mark.parametrize("kwargs", [{"epochs": 0}, {"batch_size": 0}, {"learning_rate": float("nan")}, {"seed": -1}])
def test_invalid_training_parameters_fail_before_output(source: Path, tmp_path: Path, kwargs) -> None:
    with pytest.raises(ValueError):
        train_recommendation(tmp_path / "missing", tmp_path / "run", **kwargs)
    assert not (tmp_path / "run").exists()


def test_nonfinite_training_is_marked_incomplete(source: Path, tmp_path: Path, monkeypatch) -> None:
    torch = pytest.importorskip("torch")
    prepared, run = tmp_path / "prepared", tmp_path / "run"
    prepare_recommendation(source, prepared, min_support=1)
    monkeypatch.setattr(torch.nn.BCEWithLogitsLoss, "forward", lambda self, output, target: output.sum() * float("nan"))
    with pytest.raises(ValueError, match="nonfinite loss"):
        train_recommendation(prepared, run, epochs=1)
    assert (run / "incomplete.json").is_file()
    assert not (run / "metrics.json").exists()
    assert not (run / "artifacts.json").exists()


def test_nonfinite_logits_are_rejected_before_sigmoid_can_hide_infinity() -> None:
    torch = pytest.importorskip("torch")
    model = torch.nn.Linear(2048, 2)
    with torch.no_grad():
        model.bias.fill_(float("inf"))
    with pytest.raises(ValueError, match="nonfinite scores"):
        rec._scores(torch, model, torch.zeros((2, 2048)), torch.device("cpu"), 2)
