"""Bounded in-memory image decoding, with aggregate-only outputs."""

import io
from collections import Counter
from pathlib import Path

from .data import load_image_bytes, load_manifest


def inspect_images(manifest_dir: Path, count: int = 16) -> dict:
    if count < 1 or count > 128:
        raise ValueError("Inspection count must be 1 to 128 per partition.")
    from PIL import Image, ImageOps

    partitions = {}
    for name in ("train", "validation"):
        rows = load_manifest(manifest_dir / f"{name}.jsonl")
        # Alternate classes rather than inspecting only the majority class.
        classes = [[row for row in rows if row["label"] == label] for label in ("NVP", "VP")]
        selected = [row for pair in zip(*classes) for row in pair][:count]
        if len(selected) < count:
            seen = {row["sample_id"] for row in selected}
            selected.extend(row for row in rows if row["sample_id"] not in seen)
            selected = selected[:count]
        sizes, modes, failures, exif = [], Counter(), 0, 0
        for row in selected:
            try:
                with Image.open(io.BytesIO(load_image_bytes(row))) as image:
                    image.load()
                    exif += bool(image.getexif())
                    oriented = ImageOps.exif_transpose(image)
                    sizes.append(oriented.size)
                    modes[oriented.mode] += 1
            except (OSError, ValueError, Image.DecompressionBombError):
                failures += 1
        partitions[name] = {
            "sampled": len(selected), "decode_failures": failures,
            "width_range": [min((x[0] for x in sizes), default=0), max((x[0] for x in sizes), default=0)],
            "height_range": [min((x[1] for x in sizes), default=0), max((x[1] for x in sizes), default=0)],
            "modes": dict(modes), "with_exif": exif,
        }
    result = {"partitions": partitions, "images_retained": False, "scope": "Bounded decoding sample; not a full quality, face-presence or identity audit."}
    (manifest_dir / "inspection.json").write_text(__import__("json").dumps(result, indent=2) + "\n", encoding="utf-8")
    return result
