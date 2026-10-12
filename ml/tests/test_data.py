"""Synthetic fixtures only: no licensed images or customer information."""

import csv
import hashlib
import io
import json
from pathlib import Path
import zipfile

import pytest

from senmiva_training.data import load_image_bytes, load_manifest, prepare_dataset


HEADERS = ["No", "이미지 부위 (상/중/하)", "모공 (육안 평가)"]


def csv_bytes(number: str, label: str, region: str = "중") -> bytes:
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(HEADERS)
    writer.writerow([number, region, label])
    return stream.getvalue().encode("utf-8-sig")


def write_pair(root: Path, partition: str, number: str, label: str, *, region: str = "중", image: bytes | None = None) -> None:
    folder = root / ("TS_source" if partition == "training" else "VS_source") / number
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{number}.csv").write_bytes(csv_bytes(number, label, region))
    (folder / f"{number}.JPG").write_bytes(image or f"synthetic image {partition} {number}".encode())


@pytest.fixture
def dataset(tmp_path: Path) -> Path:
    source = tmp_path / "source"
    for number, partition, label in [
        ("101", "training", "VP"), ("102", "training", "NVP"),
        ("201", "validation", "VP"), ("202", "validation", "NVP"),
    ]:
        write_pair(source, partition, number, label)
    return source


def read_summary(output: Path) -> dict:
    return json.loads((output / "summary.json").read_text(encoding="utf-8"))


def test_extracted_pairs_are_private_pseudonymized_and_integrity_checked(dataset: Path, tmp_path: Path) -> None:
    output = tmp_path / "prepared"
    result = prepare_dataset(dataset, output)
    train = load_manifest(Path(result["train_manifest"]))
    validation = load_manifest(Path(result["validation_manifest"]))
    assert len(train) == len(validation) == 2
    assert {row["label"] for row in train} == {"NVP", "VP"}
    assert all(row["split"] == "train" and row["source_partition"] == "training" for row in train)
    assert all(row["split"] == "validation" for row in validation)
    assert all(row["group_id"] == row["sample_id"] and row["grouping_verified"] is False for row in train)
    assert all(row["region"] == "중" and len(row["sample_id"]) == 64 for row in train)
    assert all(row["image_member"] is None and Path(row["image_path"]).is_absolute() for row in train)
    assert all(hashlib.sha256(load_image_bytes(row)).hexdigest() == row["image_sha256"] for row in train)
    summary = read_summary(output)
    assert str(dataset) not in json.dumps(summary)
    assert "No" not in summary
    assert summary["grouping_verified"] is False
    assert len(summary["source_partition_sha256"]["training"]) == 64
    assert summary["partitions"]["training"]["source_pairs"] == 2


def test_archived_pairs_load_without_extracting_or_using_annotation_packages(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for prefix, numbers in [("TS", ("101", "102")), ("VS", ("201", "202"))]:
        with zipfile.ZipFile(source / f"{prefix}_source.zip", "w") as archive:
            for number, label in zip(numbers, ("VP", "NVP")):
                archive.writestr(f"nested/{number}.csv", csv_bytes(number, label))
                archive.writestr(f"nested/{number}.jpg", f"zip-image-{number}")
    (source / "TL_annotations.zip").write_bytes(b"not a zip: intentionally ignored")
    result = prepare_dataset(source, tmp_path / "prepared")
    rows = load_manifest(Path(result["train_manifest"]))
    assert all(row["image_member"].startswith("nested/") for row in rows)
    assert all(load_image_bytes(row).startswith(b"zip-image-") for row in rows)
    assert not (source / "nested").exists()


def test_exact_byte_overlap_is_rejected_even_with_different_names(dataset: Path, tmp_path: Path) -> None:
    shared = b"the same image under unrelated filenames"
    (dataset / "TS_source/101/101.JPG").write_bytes(shared)
    (dataset / "VS_source/202/202.JPG").write_bytes(shared)
    with pytest.raises(ValueError, match="crosses training and validation"):
        prepare_dataset(dataset, tmp_path / "prepared")
    assert not (tmp_path / "prepared/summary.json").exists()


def test_hash_audit_includes_excluded_region_images(dataset: Path, tmp_path: Path) -> None:
    shared = b"cross split excluded region duplicate"
    write_pair(dataset, "training", "103", "VP", region="상", image=shared)
    write_pair(dataset, "validation", "203", "VP", region="하", image=shared)
    with pytest.raises(ValueError, match="crosses training and validation"):
        prepare_dataset(dataset, tmp_path / "prepared")


def test_same_partition_exact_duplicates_are_counted_and_deduplicated(dataset: Path, tmp_path: Path) -> None:
    shared = (dataset / "TS_source/101/101.JPG").read_bytes()
    write_pair(dataset, "training", "103", "VP", image=shared)
    result = prepare_dataset(dataset, tmp_path / "prepared")
    summary = result["summary"]["partitions"]["training"]
    assert summary["source_pairs"] == 3
    assert summary["exact_duplicate_images"] == 1
    assert summary["excluded_duplicate_eligible_image"] == 1
    assert summary["selected_records"] == 2


def test_exact_duplicates_with_conflicting_labels_fail(dataset: Path, tmp_path: Path) -> None:
    shared = (dataset / "TS_source/101/101.JPG").read_bytes()
    write_pair(dataset, "training", "103", "NVP", image=shared)
    with pytest.raises(ValueError, match="conflicting pore labels"):
        prepare_dataset(dataset, tmp_path / "prepared")


def test_regions_missing_labels_and_invalid_labels_have_explicit_counts(dataset: Path, tmp_path: Path) -> None:
    write_pair(dataset, "training", "103", "VP", region="상")
    write_pair(dataset, "training", "104", "")
    write_pair(dataset, "training", "105", "unverified-code")
    result = prepare_dataset(dataset, tmp_path / "prepared")
    counts = result["summary"]["partitions"]["training"]
    assert counts["source_pairs"] == 5
    assert counts["excluded_region"] == counts["excluded_missing_label"] == counts["excluded_invalid_label"] == 1
    assert counts["selected_records"] == 2


def test_stratified_limit_retains_minority_code_in_each_partition(dataset: Path, tmp_path: Path) -> None:
    for number in range(103, 111):
        write_pair(dataset, "training", str(number), "VP")
    for number in range(203, 211):
        write_pair(dataset, "validation", str(number), "VP")
    result = prepare_dataset(dataset, tmp_path / "prepared", seed=19, limit=4)
    for partition in ("training", "validation"):
        assert result["summary"]["partitions"][partition]["selected_records"] == 4
        assert result["summary"]["partitions"][partition]["selected_label_counts"] == {"NVP": 1, "VP": 3}


def test_preparation_is_deterministic_for_fixed_private_salt_and_seed(dataset: Path, tmp_path: Path) -> None:
    outputs = (tmp_path / "first", tmp_path / "second")
    for output in outputs:
        output.mkdir()
        (output / "private-salt.hex").write_text("ab" * 32 + "\n", encoding="ascii")
        prepare_dataset(dataset, output, seed=9, limit=2)
    assert (outputs[0] / "train.jsonl").read_bytes() == (outputs[1] / "train.jsonl").read_bytes()
    assert read_summary(outputs[0]) == read_summary(outputs[1])


def test_different_private_salts_produce_different_pseudonyms(dataset: Path, tmp_path: Path) -> None:
    first = prepare_dataset(dataset, tmp_path / "first")
    second = prepare_dataset(dataset, tmp_path / "second")
    first_ids = {row["sample_id"] for row in load_manifest(Path(first["train_manifest"]))}
    second_ids = {row["sample_id"] for row in load_manifest(Path(second["train_manifest"]))}
    assert first_ids.isdisjoint(second_ids)


def test_prepared_outputs_cannot_be_overwritten(dataset: Path, tmp_path: Path) -> None:
    output = tmp_path / "prepared"
    prepare_dataset(dataset, output)
    original = (output / "train.jsonl").read_bytes()
    with pytest.raises(ValueError, match="immutable"):
        prepare_dataset(dataset, output, seed=99)
    assert (output / "train.jsonl").read_bytes() == original


@pytest.mark.parametrize("relative", ["OneDrive/run", "OneDrive - Business/run", "source/outputs"])
def test_outputs_inside_source_or_onedrive_are_rejected(dataset: Path, tmp_path: Path, relative: str) -> None:
    with pytest.raises(ValueError, match="outside|separate"):
        prepare_dataset(dataset, tmp_path / relative)


def test_output_inside_repository_is_rejected(dataset: Path) -> None:
    repository = Path(__file__).resolve().parents[2]
    with pytest.raises(ValueError, match="outside|separate"):
        prepare_dataset(dataset, repository / "private-training-output")


@pytest.mark.parametrize("limit", [0, -1, True, 1.5])
def test_invalid_limits_are_rejected(dataset: Path, tmp_path: Path, limit) -> None:
    with pytest.raises(ValueError, match="positive integer"):
        prepare_dataset(dataset, tmp_path / "prepared", limit=limit)


def test_limit_cannot_silently_drop_a_class(dataset: Path, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="every present class"):
        prepare_dataset(dataset, tmp_path / "prepared", limit=1)


def test_missing_partition_or_missing_class_is_rejected(dataset: Path, tmp_path: Path) -> None:
    (dataset / "VS_source/202/202.csv").write_bytes(csv_bytes("202", "VP"))
    with pytest.raises(ValueError, match="Both pore codes"):
        prepare_dataset(dataset, tmp_path / "prepared")


def test_extracted_pairless_source_fails_without_identifier_in_error(dataset: Path, tmp_path: Path) -> None:
    (dataset / "TS_source/101/101.JPG").unlink()
    with pytest.raises(ValueError, match="incomplete") as error:
        prepare_dataset(dataset, tmp_path / "prepared")
    assert "101" not in str(error.value)
    assert str(dataset) not in str(error.value)


def test_archive_pairless_source_fails(dataset: Path, tmp_path: Path) -> None:
    with zipfile.ZipFile(dataset / "TS_extra.zip", "w") as archive:
        archive.writestr("unpaired.csv", csv_bytes("999", "VP"))
    with pytest.raises(ValueError, match="incomplete"):
        prepare_dataset(dataset, tmp_path / "prepared")


@pytest.mark.parametrize("member", ["../escape.jpg", "/absolute.jpg", "C:/drive.jpg"])
def test_unsafe_archive_entries_are_rejected(dataset: Path, tmp_path: Path, member: str) -> None:
    with zipfile.ZipFile(dataset / "TS_unsafe.zip", "w") as archive:
        archive.writestr(member, b"unsafe image")
    with pytest.raises(ValueError, match="Unsafe"):
        prepare_dataset(dataset, tmp_path / "prepared")


def test_malformed_csv_schema_fails_closed(dataset: Path, tmp_path: Path) -> None:
    (dataset / "TS_source/101/101.csv").write_text("No,label\n101,VP\n", encoding="utf-8")
    with pytest.raises(ValueError, match="schema columns"):
        prepare_dataset(dataset, tmp_path / "prepared")


def test_repeated_record_ids_are_not_treated_as_distinct_people(dataset: Path, tmp_path: Path) -> None:
    (dataset / "VS_source/201/201.csv").write_bytes(csv_bytes("101.0", "VP"))
    with pytest.raises(ValueError, match="Repeated source record"):
        prepare_dataset(dataset, tmp_path / "prepared")


def test_extracted_image_mutation_after_preparation_fails(dataset: Path, tmp_path: Path) -> None:
    result = prepare_dataset(dataset, tmp_path / "prepared")
    row = load_manifest(Path(result["train_manifest"]))[0]
    Path(row["image_path"]).write_bytes(b"replaced after preparation")
    with pytest.raises(ValueError, match="changed after"):
        load_image_bytes(row)


def test_archive_image_mutation_after_preparation_fails(dataset: Path, tmp_path: Path) -> None:
    with zipfile.ZipFile(dataset / "TS_extra.zip", "w") as archive:
        archive.writestr("999.csv", csv_bytes("999", "VP"))
        archive.writestr("999.jpg", b"original archived bytes")
    result = prepare_dataset(dataset, tmp_path / "prepared")
    row = next(row for row in load_manifest(Path(result["train_manifest"])) if row["image_member"])
    with zipfile.ZipFile(dataset / "TS_extra.zip", "w") as archive:
        archive.writestr("999.jpg", b"mutated archived bytes")
    with pytest.raises(ValueError, match="changed after"):
        load_image_bytes(row)


def test_deleted_archive_entry_after_preparation_fails_without_member_in_error(dataset: Path, tmp_path: Path) -> None:
    with zipfile.ZipFile(dataset / "TS_extra.zip", "w") as archive:
        archive.writestr("999.csv", csv_bytes("999", "VP"))
        archive.writestr("999.jpg", b"original archived bytes")
    result = prepare_dataset(dataset, tmp_path / "prepared")
    row = next(row for row in load_manifest(Path(result["train_manifest"])) if row["image_member"])
    with zipfile.ZipFile(dataset / "TS_extra.zip", "w") as archive:
        archive.writestr("other.jpg", b"replacement archive")
    with pytest.raises(ValueError, match="no longer available") as error:
        load_image_bytes(row)
    assert "999" not in str(error.value)


def test_manifest_modification_is_rejected(dataset: Path, tmp_path: Path) -> None:
    result = prepare_dataset(dataset, tmp_path / "prepared")
    path = Path(result["train_manifest"])
    path.write_bytes(path.read_bytes().replace(b'"VP"', b'"NVP"'))
    with pytest.raises(ValueError, match="integrity verification"):
        load_manifest(path)


def test_partial_preparation_is_not_loadable(dataset: Path, tmp_path: Path) -> None:
    result = prepare_dataset(dataset, tmp_path / "prepared")
    Path(result["summary_path"]).unlink()
    with pytest.raises(ValueError, match="complete, valid"):
        load_manifest(Path(result["train_manifest"]))


@pytest.mark.parametrize("member", ["../image.jpg", "folder\\image.jpg"])
def test_load_image_bytes_rejects_unsafe_member_and_relative_paths(member: str) -> None:
    with pytest.raises(ValueError, match="absolute"):
        load_image_bytes({"image_path": "relative.jpg", "image_member": None})
    with pytest.raises(ValueError, match="invalid"):
        load_image_bytes({"image_path": str(Path.cwd() / "private.zip"), "image_member": member})


def test_explicit_exclude_all_quarantines_every_shared_occurrence_and_preserves_source(dataset: Path, tmp_path: Path) -> None:
    shared = b"shared byte group with several records and conflicting labels"
    write_pair(dataset, "training", "103", "VP", image=shared)
    write_pair(dataset, "training", "104", "NVP", image=shared)
    write_pair(dataset, "training", "105", "VP", region="상", image=shared)
    write_pair(dataset, "validation", "203", "VP", image=shared)
    write_pair(dataset, "validation", "204", "NVP", image=shared)
    original_files = {str(path.relative_to(dataset)): path.read_bytes() for path in dataset.rglob("*") if path.is_file()}
    result = prepare_dataset(dataset, tmp_path / "curated", cross_split_policy="exclude-all")
    summary = result["summary"]
    assert summary["cross_split_policy"] == "exclude-all"
    assert summary["cross_split_duplicate_hash_groups"] == 1
    training, validation = (summary["partitions"][partition] for partition in ("training", "validation"))
    assert training["excluded_cross_split_source_pairs"] == 3
    assert training["excluded_cross_split_eligible_records"] == 2
    assert validation["excluded_cross_split_source_pairs"] == validation["excluded_cross_split_eligible_records"] == 2
    assert training["exact_duplicate_images"] == 2
    assert validation["exact_duplicate_images"] == 1
    assert training["eligible_records"] == validation["eligible_records"] == 2
    assert training["eligible_label_counts"] == validation["eligible_label_counts"] == {"VP": 1, "NVP": 1}
    shared_hash = hashlib.sha256(shared).hexdigest()
    for manifest in (result["train_manifest"], result["validation_manifest"]):
        assert all(row["image_sha256"] != shared_hash for row in load_manifest(Path(manifest)))
    assert shared_hash not in json.dumps(summary)
    assert summary["grouping_verified"] is False
    assert original_files == {str(path.relative_to(dataset)): path.read_bytes() for path in dataset.rglob("*") if path.is_file()}


def test_exclude_all_keeps_full_partition_membership_for_later_archive_occurrences(dataset: Path, tmp_path: Path) -> None:
    shared = b"shared across alternating partition and storage types"
    write_pair(dataset, "training", "103", "VP", image=shared)
    write_pair(dataset, "validation", "203", "VP", image=shared)
    for prefix, number in (("TS", "104"), ("VS", "204")):
        with zipfile.ZipFile(dataset / f"{prefix}_extra.zip", "w") as archive:
            archive.writestr(f"{number}.csv", csv_bytes(number, "VP"))
            archive.writestr(f"{number}.jpg", shared)
    result = prepare_dataset(dataset, tmp_path / "curated", cross_split_policy="exclude-all")
    assert result["summary"]["cross_split_duplicate_hash_groups"] == 1
    for partition in ("training", "validation"):
        counts = result["summary"]["partitions"][partition]
        assert counts["excluded_cross_split_source_pairs"] == counts["excluded_cross_split_eligible_records"] == 2
        assert counts["exact_duplicate_images"] == 1
        assert counts["selected_records"] == 2


def test_exclude_all_checks_shared_bytes_outside_eligible_regions(dataset: Path, tmp_path: Path) -> None:
    shared = b"upper training image repeated as middle validation"
    write_pair(dataset, "training", "103", "VP", region="상", image=shared)
    write_pair(dataset, "validation", "203", "VP", image=shared)
    result = prepare_dataset(dataset, tmp_path / "curated", cross_split_policy="exclude-all")
    counts = result["summary"]["partitions"]
    assert counts["training"]["excluded_cross_split_source_pairs"] == 1
    assert counts["training"]["excluded_cross_split_eligible_records"] == 0
    assert counts["validation"]["excluded_cross_split_eligible_records"] == 1


def test_exclude_all_cannot_continue_when_quarantine_removes_a_class(dataset: Path, tmp_path: Path) -> None:
    shared = b"the only positive records are shared"
    (dataset / "TS_source/101/101.JPG").write_bytes(shared)
    (dataset / "VS_source/201/201.JPG").write_bytes(shared)
    with pytest.raises(ValueError, match="Both pore codes"):
        prepare_dataset(dataset, tmp_path / "curated", cross_split_policy="exclude-all")
    assert not (tmp_path / "curated/summary.json").exists()


def test_exclude_all_cannot_continue_with_empty_partitions(dataset: Path, tmp_path: Path) -> None:
    for train, validation in (("101", "201"), ("102", "202")):
        shared = f"shared group {train}".encode()
        (dataset / f"TS_source/{train}/{train}.JPG").write_bytes(shared)
        (dataset / f"VS_source/{validation}/{validation}.JPG").write_bytes(shared)
    with pytest.raises(ValueError, match="Both source partitions"):
        prepare_dataset(dataset, tmp_path / "curated", cross_split_policy="exclude-all")


def test_exclude_all_retains_conflict_failure_for_unshared_images(dataset: Path, tmp_path: Path) -> None:
    shared = (dataset / "TS_source/101/101.JPG").read_bytes()
    write_pair(dataset, "training", "103", "NVP", image=shared)
    with pytest.raises(ValueError, match="conflicting pore labels"):
        prepare_dataset(dataset, tmp_path / "curated", cross_split_policy="exclude-all")


def test_default_rejects_overlap_before_sampling_and_policy_is_explicit(dataset: Path, tmp_path: Path) -> None:
    shared = b"shared image must never be sampled away silently"
    write_pair(dataset, "training", "103", "VP", image=shared)
    write_pair(dataset, "validation", "203", "VP", image=shared)
    with pytest.raises(ValueError, match="crosses training and validation"):
        prepare_dataset(dataset, tmp_path / "default", limit=1)
    with pytest.raises(ValueError, match="reject or exclude-all"):
        prepare_dataset(dataset, tmp_path / "invalid", cross_split_policy="keep-first")


def test_default_summary_reports_no_cross_split_quarantine(dataset: Path, tmp_path: Path) -> None:
    summary = prepare_dataset(dataset, tmp_path / "prepared")["summary"]
    assert summary["cross_split_policy"] == "reject"
    assert summary["cross_split_duplicate_hash_groups"] == 0
    for partition in ("training", "validation"):
        assert summary["partitions"][partition]["excluded_cross_split_source_pairs"] == 0
        assert summary["partitions"][partition]["excluded_cross_split_eligible_records"] == 0
