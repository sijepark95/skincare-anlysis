"""Synthetic all-target preparation and integrity tests; no licensed fixtures."""

import csv
import hashlib
import io
import json
from pathlib import Path

import pytest

from senmiva_training.data import load_image_bytes
from senmiva_training.multitask_data import (
    REGION_COLUMN, TARGET_COLUMNS, TARGETS, load_multitask_manifest, prepare_multitask,
)


def write_pair(
    source: Path, partition: str, name: str, *, labels: dict | None = None,
    region: str = "중", image: bytes | None = None, ancestor: str = "existing",
    number: str = "private-record-marker", demographic: str = "private-demographic-marker",
) -> tuple[Path, Path]:
    folder = source / ancestor / ("TS_concern-folder" if partition == "training" else "VS_concern-folder") / "nested"
    folder.mkdir(parents=True, exist_ok=True)
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(["No", "성별", "피부 고민 유형", REGION_COLUMN, *TARGET_COLUMNS.values()])
    values = labels if labels is not None else {target: classes[0] for target, classes in TARGETS.items()}
    writer.writerow([number, demographic, "private-concern-marker", region, *(values.get(target, "") for target in TARGETS)])
    csv_path, image_path = folder / f"{name}.csv", folder / f"{name}.JPG"
    csv_path.write_bytes(stream.getvalue().encode("utf-8-sig"))
    image_path.write_bytes(image if image is not None else f"synthetic image {partition} {name}".encode())
    return csv_path, image_path


@pytest.fixture
def dataset(tmp_path: Path) -> Path:
    source = tmp_path / "source"
    write_pair(source, "training", "train")
    write_pair(source, "validation", "validation", region="하")
    return source


def refresh_manifest_digest(output: Path, filename: str) -> None:
    summary_path = output / "summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary["manifest_sha256"][filename] = hashlib.sha256((output / filename).read_bytes()).hexdigest()
    summary_path.write_text(json.dumps(summary), encoding="utf-8")


def rewrite_rows(output: Path, filename: str, rows: list[dict]) -> None:
    (output / filename).write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    refresh_manifest_digest(output, filename)


def test_all_eight_source_codes_and_all_regions_are_retained_without_identity_labels(dataset: Path, tmp_path: Path) -> None:
    write_pair(dataset, "training", "upper", region="상", labels={target: classes[-1] for target, classes in TARGETS.items()})
    result = prepare_multitask(dataset, tmp_path / "prepared")
    train = load_multitask_manifest(Path(result["train_manifest"]))
    validation = load_multitask_manifest(Path(result["validation_manifest"]))
    assert len(TARGETS) == 8
    assert {row["region"] for row in train + validation} == {"상", "중", "하"}
    assert all(set(row["labels"]) == set(TARGETS) for row in train + validation)
    assert all(row["grouping_verified"] is False and row["image_member"] is None for row in train + validation)
    assert all(hashlib.sha256(load_image_bytes(row)).hexdigest() == row["image_sha256"] for row in train + validation)
    assert result["summary"]["target_schema"] == {target: list(classes) for target, classes in TARGETS.items()}
    assert result["summary"]["region_label_compatibility_verified"] is False
    assert result["summary"]["label_semantics_verified"] is False
    assert result["summary"]["partitions"]["training"]["retained_region_counts"] == {"중": 1, "상": 1}
    for row in train + validation:
        assert len(row["sample_id"]) == 64
        assert row["sample_id"] != row["image_sha256"]


def test_public_aggregates_and_private_manifests_exclude_personal_csv_values(dataset: Path, tmp_path: Path) -> None:
    output = tmp_path / "prepared"
    result = prepare_multitask(dataset, output)
    public = json.dumps(result["summary"], ensure_ascii=False) + (output / "schema.json").read_text(encoding="utf-8")
    assert str(dataset) not in public
    assert "image_path" not in json.dumps(result["summary"])
    assert "image_sha256" not in json.dumps(result["summary"])
    for filename in ("train.jsonl", "validation.jsonl", "summary.json", "schema.json"):
        payload = (output / filename).read_text(encoding="utf-8")
        assert all(marker not in payload for marker in ("private-record-marker", "private-demographic-marker", "private-concern-marker"))
    assert "no independent test set" in result["summary"]["validation_role"]


def test_salts_make_image_ids_local_to_each_preparation(dataset: Path, tmp_path: Path) -> None:
    first = prepare_multitask(dataset, tmp_path / "first")
    second = prepare_multitask(dataset, tmp_path / "second")
    first_row = load_multitask_manifest(Path(first["train_manifest"]))[0]
    second_row = load_multitask_manifest(Path(second["train_manifest"]))[0]
    assert first_row["image_sha256"] == second_row["image_sha256"]
    assert first_row["sample_id"] != second_row["sample_id"]


def test_cross_split_exclusion_hashes_even_all_missing_records_before_filtering(dataset: Path, tmp_path: Path) -> None:
    shared = b"shared source image"
    write_pair(dataset, "training", "shared", image=shared)
    write_pair(dataset, "validation", "shared_missing", image=shared, labels={})
    result = prepare_multitask(dataset, tmp_path / "prepared")
    assert result["summary"]["cross_split_duplicate_hash_groups"] == 1
    for partition in ("training", "validation"):
        summary = result["summary"]["partitions"][partition]
        assert summary["source_pairs"] == 2
        assert summary["excluded_cross_split_images"] == summary["excluded_cross_split_source_pairs"] == 1
        assert summary["retained_images"] == 1
    all_rows = load_multitask_manifest(Path(result["train_manifest"])) + load_multitask_manifest(Path(result["validation_manifest"]))
    assert hashlib.sha256(shared).hexdigest() not in {row["image_sha256"] for row in all_rows}


def test_explicit_reject_policy_stops_on_shared_images_without_completion(dataset: Path, tmp_path: Path) -> None:
    write_pair(dataset, "training", "shared", image=b"overlap")
    write_pair(dataset, "validation", "shared", image=b"overlap")
    output = tmp_path / "prepared"
    with pytest.raises(ValueError, match="crosses training and validation"):
        prepare_multitask(dataset, output, cross_split_policy="reject")
    assert not (output / "summary.json").exists()


def test_multiple_records_combine_observed_labels_and_never_guess_missing(dataset: Path, tmp_path: Path) -> None:
    image = b"complementary records one photo"
    write_pair(dataset, "training", "partial1", image=image, labels={"acne": "A", "pores": "VP"})
    write_pair(dataset, "training", "partial2", image=image, labels={"wrinkles": "W1", "pores": "VP"})
    result = prepare_multitask(dataset, tmp_path / "prepared")
    row = next(row for row in load_multitask_manifest(Path(result["train_manifest"])) if row["image_sha256"] == hashlib.sha256(image).hexdigest())
    assert row["labels"]["acne"] == "A"
    assert row["labels"]["wrinkles"] == "W1"
    assert row["labels"]["pores"] == "VP"
    assert row["labels"]["sensitivity"] is None
    assert result["summary"]["partitions"]["training"]["missing_labels"]["sensitivity"] == 1


def test_conflict_masks_only_that_target_and_cannot_be_restored_by_a_third_record(dataset: Path, tmp_path: Path) -> None:
    image = b"three conflicting observations one photo"
    for name, pore in (("first", "VP"), ("second", "NVP"), ("third", "VP")):
        write_pair(dataset, "training", name, image=image, labels={"pores": pore, "acne": "A"})
    result = prepare_multitask(dataset, tmp_path / "prepared")
    row = next(row for row in load_multitask_manifest(Path(result["train_manifest"])) if row["image_sha256"] == hashlib.sha256(image).hexdigest())
    assert row["labels"]["pores"] is None
    assert row["labels"]["acne"] == "A"
    counts = result["summary"]["partitions"]["training"]
    assert counts["conflicting_target_images"]["pores"] == 1
    assert counts["conflicting_target_images"]["acne"] == 0
    assert counts["exact_duplicate_source_images"] == 2


def test_mixed_regions_become_unknown_without_discarding_usable_labels(dataset: Path, tmp_path: Path) -> None:
    image = b"same photo mixed region metadata"
    write_pair(dataset, "training", "upper", image=image, region="상")
    write_pair(dataset, "training", "lower", image=image, region="하")
    result = prepare_multitask(dataset, tmp_path / "prepared")
    rows = load_multitask_manifest(Path(result["train_manifest"]))
    assert next(row for row in rows if row["image_sha256"] == hashlib.sha256(image).hexdigest())["region"] is None
    summary = result["summary"]["partitions"]["training"]
    assert summary["region_conflict_images"] == 1
    assert summary["retained_region_counts"]["unknown"] == 1
    assert summary["source_region_counts"] == {"중": 1, "상": 1, "하": 1}


def test_blank_region_is_unknown_and_blank_acne_is_not_na(dataset: Path, tmp_path: Path) -> None:
    write_pair(dataset, "training", "missing", labels={"pores": "VP"}, region="")
    result = prepare_multitask(dataset, tmp_path / "prepared")
    rows = load_multitask_manifest(Path(result["train_manifest"]))
    row = next(row for row in rows if row["region"] is None)
    assert row["labels"]["acne"] is None
    assert result["summary"]["partitions"]["training"]["source_label_counts"]["acne"] == {"NA": 1, "missing": 1}


def test_all_missing_images_excluded_after_merge_including_all_conflicting_targets(dataset: Path, tmp_path: Path) -> None:
    write_pair(dataset, "training", "blank", labels={})
    write_pair(dataset, "training", "conflict1", image=b"all conflicting", labels={"pores": "VP"})
    write_pair(dataset, "training", "conflict2", image=b"all conflicting", labels={"pores": "NVP"})
    result = prepare_multitask(dataset, tmp_path / "prepared")
    summary = result["summary"]["partitions"]["training"]
    assert summary["excluded_all_missing_images"] == 2
    assert summary["retained_images"] == 1
    assert summary["conflicting_target_images"]["pores"] == 1


def test_exact_source_copies_and_repeated_record_ids_are_counted_without_person_grouping(dataset: Path, tmp_path: Path) -> None:
    original_csv, original_image = write_pair(dataset, "training", "original", image=b"copy image")
    copy_csv, copy_image = write_pair(dataset, "training", "copied", ancestor="archives/copy", image=b"copy image")
    assert original_csv.read_bytes() == copy_csv.read_bytes()
    assert original_image.read_bytes() == copy_image.read_bytes()
    result = prepare_multitask(dataset, tmp_path / "prepared")
    summary = result["summary"]["partitions"]["training"]
    assert summary["source_pairs"] == 3
    assert summary["identical_source_pair_copies"] == 1
    assert summary["retained_images"] == 2
    assert all(row["grouping_verified"] is False for row in load_multitask_manifest(Path(result["train_manifest"])))


@pytest.mark.parametrize("target", list(TARGETS))
def test_unknown_visual_codes_reject_without_exposing_values(dataset: Path, tmp_path: Path, target: str) -> None:
    write_pair(dataset, "training", "unsupported", labels={target: "private-unsupported-value"})
    with pytest.raises(ValueError, match=f"unsupported visual code for {target}") as captured:
        prepare_multitask(dataset, tmp_path / "prepared")
    assert "private-unsupported-value" not in str(captured.value)
    assert str(dataset) not in str(captured.value)


def test_unknown_region_rejects(dataset: Path, tmp_path: Path) -> None:
    write_pair(dataset, "training", "unknown_region", region="private-region-value")
    with pytest.raises(ValueError, match="unsupported image region"):
        prepare_multitask(dataset, tmp_path / "prepared")


def test_annotation_or_concern_paths_cannot_create_labels_or_a_partition(dataset: Path, tmp_path: Path) -> None:
    ignored = dataset / "TL_annotations" / "VP"
    ignored.mkdir(parents=True)
    (ignored / "anything.csv").write_text("not a source CSV", encoding="utf-8")
    result = prepare_multitask(dataset, tmp_path / "prepared")
    assert result["summary"]["partitions"]["training"]["source_pairs"] == 1


def test_conflicting_partition_ancestors_reject(dataset: Path, tmp_path: Path) -> None:
    write_pair(dataset, "training", "ambiguous", ancestor="VS_outer")
    with pytest.raises(ValueError, match="conflicting publisher partitions"):
        prepare_multitask(dataset, tmp_path / "prepared")


def test_incomplete_or_ambiguous_pairs_reject(dataset: Path, tmp_path: Path) -> None:
    csv_path, image_path = write_pair(dataset, "training", "broken")
    image_path.unlink()
    with pytest.raises(ValueError, match="incomplete"):
        prepare_multitask(dataset, tmp_path / "incomplete")
    image_path.write_bytes(b"first")
    image_path.with_suffix(".jpeg").write_bytes(b"second")
    with pytest.raises(ValueError, match="Ambiguous"):
        prepare_multitask(dataset, tmp_path / "ambiguous")


def test_required_schema_and_exactly_one_complete_csv_record(dataset: Path, tmp_path: Path) -> None:
    csv_path, _ = write_pair(dataset, "training", "broken")
    csv_path.write_bytes(b"No,pores\nsecret,VP\n")
    with pytest.raises(ValueError, match="explicit visual-assessment schema"):
        prepare_multitask(dataset, tmp_path / "missing_columns")
    csv_path, _ = write_pair(dataset, "training", "broken")
    with csv_path.open("a", encoding="utf-8") as stream:
        stream.write("second,incomplete\n")
    with pytest.raises(ValueError, match="exactly one complete record"):
        prepare_multitask(dataset, tmp_path / "extra_row")


def test_prepared_output_is_private_and_never_overwritten(dataset: Path, tmp_path: Path) -> None:
    output = tmp_path / "prepared"
    prepare_multitask(dataset, output)
    before = {path.name: path.read_bytes() for path in output.iterdir()}
    with pytest.raises(ValueError, match="immutable"):
        prepare_multitask(dataset, output)
    assert before == {path.name: path.read_bytes() for path in output.iterdir()}
    with pytest.raises(ValueError, match="separate"):
        prepare_multitask(dataset, dataset / "prepared")
    with pytest.raises(ValueError, match="OneDrive"):
        prepare_multitask(dataset, tmp_path / "OneDrive" / "prepared")


def test_completion_schema_and_both_manifest_hashes_are_required(dataset: Path, tmp_path: Path) -> None:
    output = tmp_path / "prepared"
    result = prepare_multitask(dataset, output)
    original_summary = (output / "summary.json").read_bytes()
    (output / "summary.json").unlink()
    with pytest.raises(ValueError, match="complete, valid"):
        load_multitask_manifest(Path(result["train_manifest"]))
    (output / "summary.json").write_bytes(original_summary)
    (output / "validation.jsonl").write_text("{}\n", encoding="utf-8")
    with pytest.raises(ValueError, match="integrity"):
        load_multitask_manifest(Path(result["train_manifest"]))


def test_schema_tampering_rejects_even_if_manifest_files_are_intact(dataset: Path, tmp_path: Path) -> None:
    output = tmp_path / "prepared"
    result = prepare_multitask(dataset, output)
    schema = json.loads((output / "schema.json").read_text(encoding="utf-8"))
    schema["missing_code_mapping"] = {"": "NA"}
    (output / "schema.json").write_text(json.dumps(schema), encoding="utf-8")
    with pytest.raises(ValueError, match="integrity"):
        load_multitask_manifest(Path(result["train_manifest"]))


@pytest.mark.parametrize("mutation", ["extra", "missing_target", "unknown_label", "split", "grouping", "region", "member", "sample", "relative_path", "all_missing"])
def test_loader_rejects_invalid_rows_even_with_refreshed_file_digest(dataset: Path, tmp_path: Path, mutation: str) -> None:
    output = tmp_path / "prepared"
    result = prepare_multitask(dataset, output)
    rows = load_multitask_manifest(Path(result["train_manifest"]))
    row = rows[0]
    if mutation == "extra": row["person_id"] = "forbidden"
    elif mutation == "missing_target": row["labels"].pop("pores")
    elif mutation == "unknown_label": row["labels"]["pores"] = "guessed"
    elif mutation == "split": row["split"] = "validation"
    elif mutation == "grouping": row["grouping_verified"] = True
    elif mutation == "region": row["region"] = "forehead"
    elif mutation == "member": row["image_member"] = "photo.jpg"
    elif mutation == "sample": row["sample_id"] = "raw-record-number"
    elif mutation == "relative_path": row["image_path"] = "relative.jpg"
    elif mutation == "all_missing": row["labels"] = {target: None for target in TARGETS}
    rewrite_rows(output, "train.jsonl", rows)
    with pytest.raises(ValueError, match="Invalid multitask manifest row"):
        load_multitask_manifest(Path(result["train_manifest"]))


def test_loader_rejects_cross_partition_duplicate_images_even_with_updated_digests(dataset: Path, tmp_path: Path) -> None:
    output = tmp_path / "prepared"
    result = prepare_multitask(dataset, output)
    train = load_multitask_manifest(Path(result["train_manifest"]))
    validation = load_multitask_manifest(Path(result["validation_manifest"]))
    validation[0]["image_sha256"] = train[0]["image_sha256"]
    rewrite_rows(output, "validation.jsonl", validation)
    with pytest.raises(ValueError, match="Invalid multitask manifest row values"):
        load_multitask_manifest(Path(result["train_manifest"]))


def test_changed_source_photo_is_rejected_by_existing_bounded_image_reader(dataset: Path, tmp_path: Path) -> None:
    result = prepare_multitask(dataset, tmp_path / "prepared")
    row = load_multitask_manifest(Path(result["train_manifest"]))[0]
    Path(row["image_path"]).write_bytes(b"changed after preparation")
    with pytest.raises(ValueError, match="Source image changed"):
        load_image_bytes(row)


def test_empty_post_exclusion_partition_rejects(dataset: Path, tmp_path: Path) -> None:
    for image_path in dataset.rglob("*.JPG"):
        image_path.write_bytes(b"only shared image")
    with pytest.raises(ValueError, match="Both publisher partitions"):
        prepare_multitask(dataset, tmp_path / "prepared")


def extraction_markers(source: Path) -> dict:
    summary = {"schema_version": 1, "complete": True, "dataset_sha256": "b" * 64}
    (source / "summary.json").write_text(json.dumps(summary), encoding="utf-8")
    (source / "extraction-index.json").write_text(json.dumps({
        "schema_version": 1, "complete": True, "source_root": "private-source-path", "summary": summary,
    }), encoding="utf-8")
    return summary


def test_completed_managed_extraction_digest_is_retained_as_safe_aggregate(dataset: Path, tmp_path: Path) -> None:
    summary = extraction_markers(dataset)
    result = prepare_multitask(dataset, tmp_path / "prepared")
    assert result["summary"]["source_extraction_dataset_sha256"] == summary["dataset_sha256"]
    assert "private-source-path" not in json.dumps(result["summary"])


@pytest.mark.parametrize("mutation", ["incomplete", "missing_index", "missing_summary", "index_not_complete", "summary_not_complete", "digest_mismatch", "invalid_digest"])
def test_partial_or_inconsistent_managed_extraction_is_rejected(dataset: Path, tmp_path: Path, mutation: str) -> None:
    summary = extraction_markers(dataset)
    if mutation == "incomplete":
        (dataset / "incomplete.json").write_text('{"complete": false}', encoding="utf-8")
    elif mutation == "missing_index":
        (dataset / "extraction-index.json").unlink()
    elif mutation == "missing_summary":
        (dataset / "summary.json").unlink()
    elif mutation == "index_not_complete":
        index = json.loads((dataset / "extraction-index.json").read_text(encoding="utf-8"))
        index["complete"] = False
        (dataset / "extraction-index.json").write_text(json.dumps(index), encoding="utf-8")
    elif mutation == "summary_not_complete":
        summary["complete"] = False
        (dataset / "summary.json").write_text(json.dumps(summary), encoding="utf-8")
    elif mutation == "digest_mismatch":
        summary["dataset_sha256"] = "c" * 64
        (dataset / "summary.json").write_text(json.dumps(summary), encoding="utf-8")
    elif mutation == "invalid_digest":
        summary["dataset_sha256"] = "invalid"
        (dataset / "summary.json").write_text(json.dumps(summary), encoding="utf-8")
        index = json.loads((dataset / "extraction-index.json").read_text(encoding="utf-8"))
        index["summary"] = summary
        (dataset / "extraction-index.json").write_text(json.dumps(index), encoding="utf-8")
    with pytest.raises(ValueError, match="extraction"):
        prepare_multitask(dataset, tmp_path / "prepared")
    assert not (tmp_path / "prepared" / "summary.json").exists()
