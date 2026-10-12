import csv
import io
from pathlib import Path

import pytest

from senmiva_training.data import prepare_dataset
from senmiva_training.inspection import inspect_images


def make_source(root: Path, invalid: bool = False) -> Path:
    Image = pytest.importorskip("PIL.Image")
    for index, (partition, label) in enumerate((("TS_source", "NVP"), ("TS_source", "VP"), ("VS_source", "NVP"), ("VS_source", "VP"))):
        directory = root / partition
        directory.mkdir(parents=True, exist_ok=True)
        stream = io.StringIO(newline="")
        writer = csv.writer(stream)
        writer.writerow(["No", "이미지 부위 (상/중/하)", "모공 (육안 평가)"])
        writer.writerow([str(index), "중", label])
        (directory / f"{index}.csv").write_bytes(stream.getvalue().encode("utf-8-sig"))
        if invalid and index == 0:
            (directory / f"{index}.jpg").write_bytes(b"synthetic-invalid-jpeg")
        else:
            Image.new("RGB", (64, 48), (index * 50, 120, 200)).save(directory / f"{index}.jpg")
    return root


def test_inspection_decodes_both_partitions_without_retaining_images(tmp_path):
    source, output = make_source(tmp_path / "source"), tmp_path / "private"
    prepare_dataset(source, output)
    result = inspect_images(output, count=2)
    assert result["images_retained"] is False
    assert result["partitions"]["train"]["decode_failures"] == 0
    assert result["partitions"]["validation"]["width_range"] == [64, 64]
    assert result["partitions"]["train"]["modes"] == {"RGB": 2}
    assert not list(output.rglob("*.jpg"))
    assert (output / "inspection.json").exists()


def test_decode_failure_is_aggregate_without_private_source_name(tmp_path):
    source, output = make_source(tmp_path / "source", invalid=True), tmp_path / "private"
    prepare_dataset(source, output)
    result = inspect_images(output, count=2)
    assert result["partitions"]["train"]["decode_failures"] == 1
    assert str(source) not in (output / "inspection.json").read_text()


def test_inspection_is_bounded(tmp_path):
    with pytest.raises(ValueError):
        inspect_images(tmp_path, count=129)
