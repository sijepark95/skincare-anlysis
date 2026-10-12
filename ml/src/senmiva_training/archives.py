"""Explicit, bounded extraction into a fresh private research dataset.

Only ZIPs present in the original directory tree are processed. A ZIP member
which is itself a ZIP requires a separate audit and is rejected in preflight.
Originals are read only. Provenance paths are confined to the private index;
the return value and summary contain aggregate counts and fingerprints only.
Permission registration is enforced by the explicit CLI, as for preparation.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import unicodedata
import zipfile
import zlib

from .workspace import private_output


_MAX_ARCHIVES = 1_024
_MAX_SOURCE_ENTRIES = 500_000
_MAX_ENTRIES = 500_000
_MAX_FILE_BYTES = 2 * 1024**3
_MAX_ARCHIVE_BYTES = 32 * 1024**3
_MAX_TOTAL_BYTES = 250 * 1024**3
_FREE_RESERVE_BYTES = 1024**3
_CHUNK_BYTES = 1024 * 1024
_DOCUMENT_BYTES = 128 * 1024**2
_MAX_METADATA_BYTES = 256 * 1024**2
_DOCUMENT_SUFFIXES = {".txt", ".md", ".pdf", ".hwp", ".hwpx", ".doc", ".docx", ".xls", ".xlsx"}
_DATA_SUFFIXES = {".csv", ".jpg", ".jpeg", ".png", ".json", ".jsonl"}
_RESERVED = {"con", "prn", "aux", "nul", "clock$", "conin$", "conout$"} | {
    f"{prefix}{digit}" for prefix in ("com", "lpt") for digit in "123456789¹²³"
}
_SUPPORTED_COMPRESSION = {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED, zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA}


@dataclass(frozen=True)
class _Original:
    path: Path
    relative: str
    identity: tuple[int, ...]
    size: int


@dataclass(frozen=True)
class _Archive:
    source: _Original
    destination: str
    entries: tuple[zipfile.ZipInfo, ...]


def _identity(value: os.stat_result) -> tuple[int, ...]:
    # Reading changes atime on some filesystems; content identity excludes it.
    # Python 3.12 Windows path stat reports creation time in st_ctime, whereas
    # fstat reports change time. Birth time agrees across those APIs. Within a
    # live handle we additionally compare its own change time before/after.
    creation_or_change = getattr(value, "st_birthtime_ns", value.st_ctime_ns)
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, creation_or_change)


def _regular(value: os.stat_result, *, directory: bool = False) -> bool:
    wanted = stat.S_ISDIR if directory else stat.S_ISREG
    return wanted(value.st_mode) and not (
        getattr(value, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


def _parts(name: str, *, directory: bool = False) -> tuple[str, ...]:
    if directory and name.endswith("/"):
        name = name[:-1]
    parts = tuple(name.split("/"))
    if not name or len(name) > 4096 or len(parts) > 64:
        raise ValueError("Unsafe dataset destination path.")
    for part in parts:
        if (
            part in ("", ".", "..") or len(part) > 255 or part[-1:] in (".", " ")
            or any(ord(char) < 32 or ord(char) == 127 or char in '\\<>:"|?*' for char in part)
            or part.split(".", 1)[0].rstrip(" ").casefold() in _RESERVED
        ):
            raise ValueError("Unsafe dataset destination path.")
    return parts


class _Destinations:
    """Account for implicit directories, Windows casing and Unicode aliases."""

    def __init__(self) -> None:
        self.items: dict[str, tuple[str, bool]] = {}
        self.explicit: set[str] = set()

    def add(self, name: str, *, directory: bool = False) -> None:
        parts = _parts(name, directory=directory)
        for index in range(1, len(parts) + 1):
            spelling = "/".join(parts[:index])
            key = unicodedata.normalize("NFC", spelling).casefold()
            is_directory = index < len(parts) or directory
            previous = self.items.get(key)
            if previous is not None and (previous != (spelling, is_directory) or not is_directory):
                raise ValueError("Case-insensitive dataset destination collision.")
            self.items[key] = (spelling, is_directory)
        if directory:
            key = unicodedata.normalize("NFC", "/".join(parts)).casefold()
            if key in self.explicit:
                raise ValueError("Case-insensitive dataset destination collision.")
            self.explicit.add(key)


def _inventory(source: Path) -> tuple[list[_Original], list[_Original]]:
    archives: list[_Original] = []
    originals: list[_Original] = []
    destinations = _Destinations()
    count = 0
    def walk_failure(_error: OSError) -> None:
        raise ValueError("Dataset source could not be completely inventoried.")

    for directory, folders, files in os.walk(source, followlinks=False, onerror=walk_failure):
        folders.sort()
        files.sort()
        for name, is_directory in [(name, True) for name in folders] + [(name, False) for name in files]:
            count += 1
            if count > _MAX_SOURCE_ENTRIES:
                raise ValueError("Dataset source entry limit exceeded.")
            path = Path(directory) / name
            relative = path.relative_to(source).as_posix()
            value = path.lstat()
            if not _regular(value, directory=is_directory):
                raise ValueError("Dataset source contains a symbolic link or special file.")
            destinations.add(relative, directory=is_directory)
            if is_directory:
                continue
            item = _Original(path, relative, _identity(value), value.st_size)
            suffix = path.suffix.casefold()
            if suffix == ".zip":
                if item.size > _MAX_ARCHIVE_BYTES:
                    raise ValueError("Dataset archive size limit exceeded.")
                archives.append(item)
                if len(archives) > _MAX_ARCHIVES:
                    raise ValueError("Dataset archive count limit exceeded.")
            else:
                if suffix not in _DATA_SUFFIXES | _DOCUMENT_SUFFIXES:
                    raise ValueError("Dataset source contains an unsupported original file format.")
                limit = _DOCUMENT_BYTES if suffix in _DOCUMENT_SUFFIXES else _MAX_FILE_BYTES
                if item.size > limit:
                    raise ValueError("Dataset original file size limit exceeded.")
                originals.append(item)
    return archives, originals


def _open_original(item: _Original):
    descriptor = os.open(item.path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
    stream = os.fdopen(descriptor, "rb")
    if not _regular(os.fstat(stream.fileno())) or _identity(os.fstat(stream.fileno())) != item.identity:
        stream.close()
        raise ValueError("Dataset source changed during extraction.")
    return stream


def _handle_stamp(stream) -> tuple[int, ...]:
    value = os.fstat(stream.fileno())
    return (*_identity(value), value.st_ctime_ns)


def _unchanged(item: _Original, stream, stamp: tuple[int, ...]) -> None:
    value = item.path.lstat()
    if not _regular(value) or _identity(value) != item.identity or _handle_stamp(stream) != stamp:
        raise ValueError("Dataset source changed during extraction.")


def _member(info: zipfile.ZipInfo) -> bool:
    directory = info.is_dir()
    # ZipInfo truncates a NUL-containing filename; orig_filename retains it.
    if info.orig_filename != info.filename:
        raise ValueError("Unsafe dataset archive entry.")
    _parts(info.filename, directory=directory)
    mode = info.external_attr >> 16
    kind = stat.S_IFMT(mode)
    if kind and kind != (stat.S_IFDIR if directory else stat.S_IFREG):
        raise ValueError("Dataset archive contains a symbolic link or special entry.")
    # DOS attributes: directory/regular consistency and reparse points.
    attributes = info.external_attr & 0xFFFF
    if (attributes & 0x400) or (attributes & 0x10 and not directory):
        raise ValueError("Dataset archive contains a symbolic link or special entry.")
    if info.flag_bits & 1:
        raise ValueError("Encrypted dataset archives are not supported.")
    if info.compress_type not in _SUPPORTED_COMPRESSION:
        raise ValueError("Unsupported dataset archive compression.")
    if info.file_size < 0 or info.file_size > _MAX_FILE_BYTES or info.compress_size < 0:
        raise ValueError("Dataset archive entry size limit exceeded.")
    if directory and info.file_size:
        raise ValueError("Dataset archive directory contains unexpected data.")
    if not directory and Path(info.filename).suffix.casefold() == ".zip":
        raise ValueError("Nested ZIP members require a separate extraction audit.")
    return directory


def _info_identity(info: zipfile.ZipInfo) -> tuple:
    return (info.orig_filename, info.filename, info.file_size, info.compress_size, info.CRC,
            info.flag_bits, info.compress_type, info.external_attr, info.header_offset)


def _bounded_metadata(stream, remaining: int) -> None:
    """Bound central-directory allocation before ZipFile builds its object list.

    Count real central headers as well as the declared count, so a false EOCD
    count cannot bypass the entry bound. Only ordinary single-volume ZIP/ZIP64
    layouts are supported, including a possible self-extracting prefix.
    """
    stream.seek(0, os.SEEK_END)
    size = stream.tell()
    tail_size = min(size, 65_557)
    stream.seek(size - tail_size)
    tail = stream.read(tail_size)
    position = tail.rfind(b"PK\x05\x06")
    while position >= 0:
        if position + 22 <= len(tail):
            fields = struct.unpack_from("<4s4H2LH", tail, position)
            if position + 22 + fields[-1] == len(tail):
                break
        position = tail.rfind(b"PK\x05\x06", 0, position)
    if position < 0:
        raise ValueError("Dataset archive has an invalid end record.")
    _, disk, central_disk, disk_entries, entries, central_bytes, _central_offset, _comment = fields
    if disk or central_disk or disk_entries != entries:
        raise ValueError("Multi-volume dataset archives are not supported.")
    central_end = size - tail_size + position
    if entries == 0xFFFF or central_bytes == 0xFFFFFFFF or _central_offset == 0xFFFFFFFF:
        if central_end < 20:
            raise ValueError("Dataset ZIP64 metadata is invalid.")
        stream.seek(central_end - 20)
        locator = stream.read(20)
        signature, zip_disk, zip_offset, disk_count = struct.unpack("<4sLQL", locator)
        if signature != b"PK\x06\x07" or zip_disk or disk_count != 1 or zip_offset > central_end - 76:
            raise ValueError("Dataset ZIP64 metadata is invalid.")
        stream.seek(zip_offset)
        record = stream.read(56)
        if len(record) != 56:
            raise ValueError("Dataset ZIP64 metadata is invalid.")
        signature, length, _made, _needed, disk, central_disk, disk_entries, entries, central_bytes, _central_offset = struct.unpack("<4sQ2H2L4Q", record)
        if (signature != b"PK\x06\x06" or not 44 <= length <= 4096 or disk or central_disk
                or disk_entries != entries or zip_offset + 12 + length != central_end - 20):
            raise ValueError("Dataset ZIP64 metadata is invalid.")
        central_end = zip_offset
    if entries > remaining or central_bytes > _MAX_METADATA_BYTES or central_bytes > central_end:
        raise ValueError("Dataset extracted entry or metadata limit exceeded.")
    cursor = central_end - central_bytes
    actual_entries = 0
    while cursor < central_end:
        stream.seek(cursor)
        header = stream.read(46)
        if len(header) != 46 or header[:4] != b"PK\x01\x02":
            raise ValueError("Dataset archive central directory is invalid.")
        lengths = struct.unpack_from("<HHH", header, 28)
        cursor += 46 + sum(lengths)
        actual_entries += 1
        if cursor > central_end or actual_entries > remaining:
            raise ValueError("Dataset extracted entry or metadata limit exceeded.")
    if actual_entries != entries:
        raise ValueError("Dataset archive entry count is inconsistent.")
    stream.seek(0)


def _nearest_parent(path: Path) -> Path:
    parent = path.parent
    while not parent.exists():
        parent = parent.parent
    return parent


def _preflight(source: Path, output: Path) -> tuple[list[_Archive], list[_Original], dict]:
    compressed, originals = _inventory(source)
    if not compressed and not originals:
        raise ValueError("Dataset source contains no supported files.")
    destinations = _Destinations()
    planned: list[_Archive] = []
    total_bytes = sum(item.size for item in originals)
    total_entries = len(originals)
    archive_files = 0
    archive_directories = 0
    by_extension: Counter = Counter(Path(item.relative).suffix.casefold() for item in originals)
    for item in originals:
        destinations.add(f"existing/{item.relative}")
    for item in compressed:
        token = hashlib.sha256(item.relative.encode("utf-8")).hexdigest()
        destination = f"archives/{token}/{Path(item.relative).stem}"
        destinations.add(destination, directory=True)
        with _open_original(item) as stream:
            stamp = _handle_stamp(stream)
            _bounded_metadata(stream, _MAX_ENTRIES - total_entries)
            with zipfile.ZipFile(stream) as archive:
                entries = tuple(archive.infolist())
            total_entries += len(entries)
            if total_entries > _MAX_ENTRIES:
                raise ValueError("Dataset extracted entry limit exceeded.")
            for info in entries:
                directory = _member(info)
                destinations.add(f"{destination}/{info.filename}", directory=directory)
                total_bytes += info.file_size
                if total_bytes > _MAX_TOTAL_BYTES:
                    raise ValueError("Dataset extracted byte limit exceeded.")
                if directory:
                    archive_directories += 1
                else:
                    archive_files += 1
                    by_extension[Path(info.filename).suffix.casefold()] += 1
            _unchanged(item, stream, stamp)
        planned.append(_Archive(item, destination, entries))
    if total_entries > _MAX_ENTRIES or total_bytes > _MAX_TOTAL_BYTES:
        raise ValueError("Dataset extracted size or entry limit exceeded.")
    reserve = max(_FREE_RESERVE_BYTES, total_bytes // 20)
    if shutil.disk_usage(_nearest_parent(output)).free < total_bytes + reserve:
        raise ValueError("Insufficient private disk space for complete dataset extraction.")
    # Extension strings in an archive may contain record identifiers. Report only
    # recognized categories and a single other count, never arbitrary suffixes.
    known = _DATA_SUFFIXES | _DOCUMENT_SUFFIXES
    extensions = {suffix: by_extension[suffix] for suffix in sorted(known) if by_extension[suffix]}
    other = sum(count for suffix, count in by_extension.items() if suffix not in known)
    if other:
        extensions["other"] = other
    summary = {
        "schema_version": 1, "complete": True, "archive_count": len(planned),
        "source_archive_bytes": sum(item.size for item in compressed),
        "archive_file_count": archive_files, "archive_directory_count": archive_directories,
        "copied_original_file_count": len(originals),
        "output_file_count": archive_files + len(originals), "output_bytes": total_bytes,
        "files_by_extension": extensions, "nested_archive_count": 0,
    }
    return planned, originals, summary


def _target(root: Path, relative: str, *, directory: bool = False) -> Path:
    parts = _parts(relative, directory=directory)
    target = root.joinpath(*parts)
    parent = root
    for part in parts if directory else parts[:-1]:
        parent = parent / part
        if not parent.exists():
            parent.mkdir(mode=0o700)
        if not _regular(parent.lstat(), directory=True) or not parent.resolve().is_relative_to(root):
            raise ValueError("Unsafe extraction destination.")
    if not target.resolve().is_relative_to(root):
        raise ValueError("Unsafe extraction destination.")
    return target


def _write_stream(root: Path, relative: str, stream, expected: int, *, expected_crc: int | None = None) -> str:
    target = _target(root, relative)
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
                         | getattr(os, "O_NOFOLLOW", 0), 0o600)
    digest = hashlib.sha256()
    total = 0
    crc = 0
    with os.fdopen(descriptor, "wb") as destination:
        while True:
            chunk = stream.read(min(_CHUNK_BYTES, expected - total + 1))
            if not chunk:
                break
            total += len(chunk)
            if total > expected or total > _MAX_FILE_BYTES:
                raise ValueError("Dataset stream exceeded its declared size.")
            destination.write(chunk)
            digest.update(chunk)
            crc = zlib.crc32(chunk, crc)
    if total != expected or (expected_crc is not None and crc != expected_crc):
        raise ValueError("Dataset stream size or CRC verification failed.")
    return digest.hexdigest()


def _write_json(path: Path, payload: dict) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")
    path.chmod(0o600)


def extract_dataset(source: Path, output: Path) -> dict:
    """Extract all original-tree ZIPs and copy recognized standalone originals.

    ``output`` must not exist, and must be outside the source, repository and
    OneDrive. All entry paths, types, collisions, total bytes and disk capacity
    are checked before creation. Partial failures retain an explicitly incomplete
    fresh directory for local review and can never overwrite an earlier dataset.
    The caller must verify the source's recorded permission before invoking this
    function. No image is decoded and no model is evaluated or trained.
    """
    source = Path(source).expanduser()
    if not source.exists() or not _regular(source.lstat(), directory=True):
        raise ValueError("Dataset source must be a regular directory.")
    source = source.resolve()
    output = private_output(Path(output), source)
    if output.exists():
        raise ValueError("Extracted datasets are immutable; choose a fresh output directory.")
    planned, originals, summary = _preflight(source, output)
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    output.mkdir(mode=0o700)
    index: dict = {"schema_version": 1, "complete": False, "source_root": str(source),
                   "archives": [], "copied_originals": []}
    fingerprint = hashlib.sha256()
    try:
        for item in originals:
            relative = f"existing/{item.relative}"
            with _open_original(item) as stream:
                stamp = _handle_stamp(stream)
                digest = _write_stream(output, relative, stream, item.size)
                _unchanged(item, stream, stamp)
            record = {"source_relative_path": item.relative, "destination_relative_path": relative,
                      "bytes": item.size, "sha256": digest}
            index["copied_originals"].append(record)
            fingerprint.update(json.dumps(record, sort_keys=True, ensure_ascii=False).encode("utf-8"))
        for plan in planned:
            records = []
            _target(output, plan.destination, directory=True)
            with _open_original(plan.source) as stream:
                stamp = _handle_stamp(stream)
                archive_hash = hashlib.file_digest(stream, "sha256").hexdigest()
                stream.seek(0)
                with zipfile.ZipFile(stream) as archive:
                    if [_info_identity(entry) for entry in archive.infolist()] != [_info_identity(entry) for entry in plan.entries]:
                        raise ValueError("Dataset source changed during extraction.")
                    for info in plan.entries:
                        relative = f"{plan.destination}/{info.filename}"
                        if info.is_dir():
                            _target(output, relative, directory=True)
                            continue
                        with archive.open(info) as member:
                            digest = _write_stream(output, relative, member, info.file_size, expected_crc=info.CRC)
                        records.append({"member": info.filename, "destination_relative_path": relative,
                                        "bytes": info.file_size, "crc32": info.CRC, "sha256": digest})
                _unchanged(plan.source, stream, stamp)
            record = {"source_relative_path": plan.source.relative, "destination_relative_path": plan.destination,
                      "archive_sha256": archive_hash, "archive_bytes": plan.source.size, "files": records}
            index["archives"].append(record)
            fingerprint.update(json.dumps(record, sort_keys=True, ensure_ascii=False).encode("utf-8"))
        # Catch additions/removals/renames or original replacements during work.
        after_archives, after_originals = _inventory(source)
        if ([item for item in after_archives] != [plan.source for plan in planned] or after_originals != originals):
            raise ValueError("Dataset source changed during extraction.")
        summary["dataset_sha256"] = fingerprint.hexdigest()
        index["complete"] = True
        index["summary"] = summary
        _write_json(output / "extraction-index.json", index)
        _write_json(output / "summary.json", summary)
        return summary
    except Exception:
        _write_json(output / "incomplete.json", {"complete": False, "error": "Dataset extraction did not complete."})
        raise
