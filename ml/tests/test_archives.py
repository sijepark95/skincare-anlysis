"""Synthetic extraction fixtures only; no licensed records or images."""

import hashlib
import io
import json
import os
from pathlib import Path
import stat
import struct
import zipfile
from contextlib import nullcontext

import pytest

from senmiva_training import archives
from senmiva_training.archives import extract_dataset
from senmiva_training.data import _extracted_partition


def make_zip(path: Path, members: list[tuple[str | zipfile.ZipInfo, bytes]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in members:
            archive.writestr(name, payload)


def source_tree(root: Path) -> dict:
    return {
        file.relative_to(root).as_posix(): (hashlib.sha256(file.read_bytes()).hexdigest(), file.stat().st_mtime_ns)
        for file in root.rglob("*") if file.is_file()
    }


def synthetic_source(tmp_path: Path) -> Path:
    source = tmp_path / "source"
    for directory, prefix, ext in [("a/개방데이터", "TS", ".csv"), ("b/개방데이터", "VS", ".csv"),
                                   ("c", "TL", ".jsonl"), ("d", "VL", ".jsonl")]:
        make_zip(source / directory / f"{prefix}_source.zip", [(f"nested/private-record{ext}", b"synthetic"),
                                                               ("nested/private-record.jpg", b"synthetic-image")])
    existing = source / "already/TS_source/private-original"
    existing.mkdir(parents=True)
    (existing / "private-original.csv").write_bytes(b"synthetic-csv")
    (existing / "private-original.JPG").write_bytes(b"synthetic-jpg")
    (source / "schema.xlsx").write_bytes(b"synthetic-workbook")
    return source


def test_complete_private_layout_preserves_sources_and_partitions(tmp_path: Path) -> None:
    source = synthetic_source(tmp_path)
    before = source_tree(source)
    output = tmp_path / "private/datasets/expanded-001"
    result = extract_dataset(source, output)
    assert source_tree(source) == before
    assert result["archive_count"] == 4
    assert result["archive_file_count"] == 8
    assert result["copied_original_file_count"] == 3
    assert result["output_file_count"] == 11
    assert result["output_bytes"] == sum(len(value) for _name, value in [
        ("", b"synthetic"), ("", b"synthetic-image")]) * 4 + len(b"synthetic-csvsynthetic-jpgsynthetic-workbook")
    assert result["files_by_extension"] == {".csv": 3, ".jpg": 5, ".jsonl": 2, ".xlsx": 1}
    assert len(result["dataset_sha256"]) == 64
    assert result == json.loads((output / "summary.json").read_text(encoding="utf-8"))
    assert not list(output.rglob("*.zip"))
    assert (output / "existing/already/TS_source/private-original/private-original.JPG").read_bytes() == b"synthetic-jpg"
    index = json.loads((output / "extraction-index.json").read_text(encoding="utf-8"))
    assert index["complete"] is True
    assert index["source_root"] == str(source)
    for archive in index["archives"]:
        token = hashlib.sha256(archive["source_relative_path"].encode()).hexdigest()
        assert Path(archive["destination_relative_path"]).parts[1] == token
        for member in archive["files"]:
            destination = output / member["destination_relative_path"]
            assert hashlib.sha256(destination.read_bytes()).hexdigest() == member["sha256"]
            prefix = Path(archive["source_relative_path"]).stem[:2]
            expected_partition = {"TS": "training", "VS": "validation"}.get(prefix)
            assert _extracted_partition(destination, output) == expected_partition


def test_public_report_has_no_original_names_or_paths_and_hash_is_repeatable(tmp_path: Path) -> None:
    source = tmp_path / "private-source-identifier"
    make_zip(source / "TS_private-package.zip", [("private-person.private-code", b"synthetic")])
    first = extract_dataset(source, tmp_path / "first")
    second = extract_dataset(source, tmp_path / "second")
    assert first == second
    public = json.dumps(first)
    for private in (str(source), "private-person", "private-code", "private-package", "private-source-identifier"):
        assert private not in public
    assert first["files_by_extension"] == {"other": 1}


@pytest.mark.parametrize("name", ["../escape.jpg", "nested/../../escape.jpg", "/absolute.jpg", "C:/drive.jpg",
                                 "C:relative.jpg", "//server/share.jpg", "\\\\server\\share.jpg", "a\\b.jpg",
                                 "a//b.jpg", "a/./b.jpg", "a/../b.jpg", "a.jpg:stream", "NUL.jpg", "aux/file.jpg",
                                 "COM1.csv", "LPT².csv", "trailing./file.jpg", "space /file.jpg", "bad?.jpg",
                                 "CON .jpg", "bad\x00.jpg", "control\x1f.jpg"])
def test_unsafe_archive_names_fail_before_creating_output(tmp_path: Path, name: str) -> None:
    source = tmp_path / "source"
    # ZipFile itself truncates NUL on writing; inject it into both headers instead.
    if "\x00" in name or name == "a\\b.jpg":
        placeholder = "badX.jpg" if "\x00" in name else "aXb.jpg"
        make_zip(source / "TS_source.zip", [(placeholder, b"synthetic")])
        path = source / "TS_source.zip"
        path.write_bytes(path.read_bytes().replace(placeholder.encode(), name.encode()))
    else:
        make_zip(source / "TS_source.zip", [(name, b"synthetic")])
    before = source_tree(source)
    with pytest.raises(ValueError, match="Unsafe"):
        extract_dataset(source, tmp_path / "private")
    assert not (tmp_path / "private").exists()
    assert source_tree(source) == before


@pytest.mark.parametrize("members", [[("Photo.jpg", b"a"), ("photo.JPG", b"b")],
                                     [("same.jpg", b"a"), ("same.jpg", b"b")],
                                     [("folder", b"a"), ("folder/photo.jpg", b"b")],
                                     [("Folder/a.jpg", b"a"), ("folder/b.jpg", b"b")],
                                     [("caf\u00e9.jpg", b"a"), ("cafe\u0301.jpg", b"b")]])
def test_case_unicode_duplicate_and_file_directory_collisions_fail_preflight(tmp_path: Path, members) -> None:
    source = tmp_path / "source"
    with pytest.warns(UserWarning) if members[0][0] == members[1][0] else nullcontext():
        make_zip(source / "TS_source.zip", members)
    with pytest.raises(ValueError, match="collision"):
        extract_dataset(source, tmp_path / "private")
    assert not (tmp_path / "private").exists()


@pytest.mark.parametrize("kind", [stat.S_IFLNK, stat.S_IFIFO, stat.S_IFCHR, stat.S_IFSOCK])
def test_symbolic_and_special_zip_entries_fail_preflight(tmp_path: Path, kind: int) -> None:
    source = tmp_path / "source"
    entry = zipfile.ZipInfo("photo.jpg")
    entry.create_system = 3
    entry.external_attr = (kind | 0o600) << 16
    make_zip(source / "TS_source.zip", [(entry, b"synthetic")])
    with pytest.raises(ValueError, match="symbolic link or special"):
        extract_dataset(source, tmp_path / "private")
    assert not (tmp_path / "private").exists()


def test_encrypted_zip_fails_preflight(tmp_path: Path) -> None:
    source = tmp_path / "source"
    path = source / "TS_source.zip"
    make_zip(path, [("photo.jpg", b"synthetic")])
    payload = bytearray(path.read_bytes())
    struct.pack_into("<H", payload, 6, struct.unpack_from("<H", payload, 6)[0] | 1)
    central = payload.index(b"PK\x01\x02")
    struct.pack_into("<H", payload, central + 8, struct.unpack_from("<H", payload, central + 8)[0] | 1)
    path.write_bytes(payload)
    with pytest.raises(ValueError, match="Encrypted"):
        extract_dataset(source, tmp_path / "private")
    assert not (tmp_path / "private").exists()


def test_embedded_zip_requires_a_separate_audit(tmp_path: Path) -> None:
    source = tmp_path / "source"
    make_zip(source / "TS_source.zip", [("nested/another.ZIP", b"synthetic")])
    with pytest.raises(ValueError, match="Nested ZIP"):
        extract_dataset(source, tmp_path / "private")
    assert not (tmp_path / "private").exists()


@pytest.mark.parametrize("bound,value", [("_MAX_ARCHIVES", 0), ("_MAX_ENTRIES", 1), ("_MAX_FILE_BYTES", 3),
                                       ("_MAX_TOTAL_BYTES", 3), ("_MAX_ARCHIVE_BYTES", 3), ("_MAX_SOURCE_ENTRIES", 1),
                                       ("_MAX_METADATA_BYTES", 3)])
def test_preflight_size_count_metadata_and_total_bounds(tmp_path: Path, monkeypatch, bound: str, value: int) -> None:
    source = tmp_path / "source"
    make_zip(source / "nested/TS_source.zip", [("a.jpg", b"synthetic"), ("b.csv", b"synthetic")])
    monkeypatch.setattr(archives, bound, value)
    with pytest.raises(ValueError, match="limit"):
        extract_dataset(source, tmp_path / "private")
    assert not (tmp_path / "private").exists()


def test_disk_space_preflight_includes_standalone_originals_and_reserve(tmp_path: Path, monkeypatch) -> None:
    source = synthetic_source(tmp_path)
    monkeypatch.setattr(archives.shutil, "disk_usage", lambda _path: type("Usage", (), {"free": 1})())
    with pytest.raises(ValueError, match="disk space"):
        extract_dataset(source, tmp_path / "private")
    assert not (tmp_path / "private").exists()


def test_incorrect_declared_central_count_cannot_bypass_bound(tmp_path: Path) -> None:
    source = tmp_path / "source"
    path = source / "TS_source.zip"
    make_zip(path, [("a.jpg", b"synthetic"), ("b.csv", b"synthetic")])
    payload = bytearray(path.read_bytes())
    end = payload.index(b"PK\x05\x06")
    struct.pack_into("<HH", payload, end + 8, 1, 1)
    path.write_bytes(payload)
    with pytest.raises(ValueError, match="count is inconsistent"):
        extract_dataset(source, tmp_path / "private")
    assert not (tmp_path / "private").exists()


def test_bounded_zip64_metadata_is_supported(tmp_path: Path) -> None:
    source = tmp_path / "source"
    path = source / "TS_source.zip"
    make_zip(path, [("photo.jpg", b"synthetic")])
    payload = path.read_bytes()
    end = payload.index(b"PK\x05\x06")
    fields = list(struct.unpack("<4s4H2LH", payload[end:]))
    zip64 = struct.pack("<4sQ2H2L4Q", b"PK\x06\x06", 44, 45, 45, 0, 0, fields[3], fields[4], fields[5], fields[6])
    locator = struct.pack("<4sLQL", b"PK\x06\x07", 0, end, 1)
    fields[3] = fields[4] = 0xFFFF
    fields[5] = fields[6] = 0xFFFFFFFF
    path.write_bytes(payload[:end] + zip64 + locator + struct.pack("<4s4H2LH", *fields))
    result = extract_dataset(source, tmp_path / "private")
    assert result["archive_count"] == 1
    assert result["archive_file_count"] == 1
    assert result["output_bytes"] == len(b"synthetic")


def test_crc_corruption_leaves_incomplete_marker_and_never_overwrites(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    path = source / "TS_source.zip"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("photo.jpg", b"synthetic-payload")
    path.write_bytes(path.read_bytes().replace(b"synthetic-payload", b"corrupted-payload"))
    output = tmp_path / "private"
    before = source_tree(source)
    with pytest.raises(zipfile.BadZipFile, match="CRC"):
        extract_dataset(source, output)
    assert source_tree(source) == before
    assert not (output / "summary.json").exists()
    assert json.loads((output / "incomplete.json").read_text()) == {"complete": False, "error": "Dataset extraction did not complete."}
    with pytest.raises(ValueError, match="immutable"):
        extract_dataset(source, output)


def test_size_stream_verification_rejects_short_and_excessive_payload(tmp_path: Path) -> None:
    output = tmp_path / "output"
    output.mkdir()
    with pytest.raises(ValueError, match="size or CRC"):
        archives._write_stream(output, "short.jpg", io.BytesIO(b"a"), 2)
    with pytest.raises(ValueError, match="declared size"):
        archives._write_stream(output, "long.jpg", io.BytesIO(b"abc"), 2)


def test_existing_outputs_and_cloud_repository_or_source_overlap_are_rejected(tmp_path: Path) -> None:
    source = synthetic_source(tmp_path)
    existing = tmp_path / "existing"
    existing.mkdir()
    (existing / "keep.txt").write_text("unchanged")
    for output in (existing, source / "expanded", source, source.parent, tmp_path / "OneDrive/private",
                   Path(__file__).resolve().parents[1] / "outputs"):
        with pytest.raises(ValueError):
            extract_dataset(source, output)
    assert (existing / "keep.txt").read_text() == "unchanged"


def test_unrecognized_original_is_not_silently_omitted(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    (source / "unexpected.exe").write_bytes(b"synthetic")
    with pytest.raises(ValueError, match="unsupported original"):
        extract_dataset(source, tmp_path / "private")
    assert not (tmp_path / "private").exists()


def test_standalone_documents_and_only_extracted_data_are_copied(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    for suffix in (".csv", ".jpg", ".JSONL", ".xlsx", ".hwp", ".hwpx", ".pdf", ".docx", ".txt"):
        (source / f"synthetic{suffix}").write_bytes(b"synthetic")
    result = extract_dataset(source, tmp_path / "private")
    assert result["archive_count"] == 0
    assert result["copied_original_file_count"] == 9
    assert result["output_bytes"] == 9 * len(b"synthetic")


def test_symlink_originals_are_rejected(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    target = tmp_path / "target.jpg"
    target.write_bytes(b"synthetic")
    try:
        (source / "link.jpg").symlink_to(target)
    except OSError:
        pytest.skip("Creating Windows symbolic links requires developer mode or elevated privileges.")
    with pytest.raises(ValueError, match="symbolic link or special"):
        extract_dataset(source, tmp_path / "private")
    assert not (tmp_path / "private").exists()


def test_source_mutation_after_preflight_is_detected(tmp_path: Path, monkeypatch) -> None:
    source = synthetic_source(tmp_path)
    original_preflight = archives._preflight
    def change_after_preflight(source, output):
        plan = original_preflight(source, output)
        (source / "schema.xlsx").write_bytes(b"changed synthetic workbook")
        return plan
    monkeypatch.setattr(archives, "_preflight", change_after_preflight)
    with pytest.raises(ValueError, match="source changed"):
        extract_dataset(source, tmp_path / "private")
    assert not (tmp_path / "private/summary.json").exists()
    assert (tmp_path / "private/incomplete.json").exists()


def test_windows_path_and_handle_ctime_difference_uses_birthtime_consistently() -> None:
    class WindowsStat:
        st_dev = 1
        st_ino = 2
        st_size = 3
        st_mtime_ns = 4
        st_birthtime_ns = 5
    path = WindowsStat()
    handle = WindowsStat()
    path.st_ctime_ns = 5
    handle.st_ctime_ns = 999
    assert archives._identity(path) == archives._identity(handle)


def test_private_creation_modes_are_requested_for_data_and_index(tmp_path: Path, monkeypatch) -> None:
    source = synthetic_source(tmp_path)
    real_open = os.open
    modes = []
    def record_open(path, flags, mode=0o777, **kwargs):
        if flags & os.O_CREAT:
            modes.append(mode)
        return real_open(path, flags, mode, **kwargs)
    monkeypatch.setattr(archives.os, "open", record_open)
    output = tmp_path / "private"
    extract_dataset(source, output)
    assert modes and set(modes) == {0o600}
    if os.name != "nt":
        assert stat.S_IMODE(output.stat().st_mode) == 0o700
        assert all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in output.rglob("*") if path.is_file())
