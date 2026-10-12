"""Prepare or verify the local AELUNE scroll sequence; never generates or transmits media.

Python requires Pillow. Supply --ffmpeg, install ffmpeg on PATH, or use the
ignored .local/media-tools/imageio_ffmpeg installation used during production.
Existing sequences are never overwritten. Original footage is kept intact.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
TARGET = PUBLIC / "media/aelune/story"


def verify() -> dict:
    manifest = json.loads((TARGET / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["version"] == 1
    frames = manifest["frames"]
    assert 2 <= len(frames) == manifest["frameCount"] <= 1200
    assert len(set(frames)) == len(frames)
    paths = []
    for index, url in enumerate(frames):
        assert url == f"/media/aelune/story/frame-{index:04d}.webp"
        path = PUBLIC / url.lstrip("/")
        assert path.resolve().is_relative_to(TARGET.resolve())
        assert path.is_file() and path.stat().st_size > 0
        paths.append(path)
    for index in (0, len(paths) // 2, len(paths) - 1):
        with Image.open(paths[index]) as image:
            assert image.format == "WEBP"
            assert list(image.size) == [manifest["width"], manifest["height"]]
            image.verify()
    assert (PUBLIC / manifest["poster"].lstrip("/")).is_file()
    return {"frames": len(paths), "width": manifest["width"], "height": manifest["height"],
            "durationSeconds": manifest["durationSeconds"], "bytes": sum(p.stat().st_size for p in paths),
            "largestFrameBytes": max(p.stat().st_size for p in paths)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--ffmpeg")
    parser.add_argument("--source", default="public/media/aelune/inside-the-drop.mp4")
    args = parser.parse_args()
    if args.check:
        print(json.dumps(verify(), indent=2))
        return
    source = (ROOT / args.source).resolve()
    if not source.is_relative_to(ROOT) or not source.is_file():
        raise ValueError("Source must be an existing file inside this workspace.")
    if TARGET.exists():
        raise ValueError("An existing sequence is preserved; prepare a new version in a new directory.")
    ffmpeg = args.ffmpeg or shutil.which("ffmpeg")
    if not ffmpeg:
        sys.path.insert(0, str(ROOT / ".local/media-tools"))
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    probe = subprocess.run([ffmpeg, "-hide_banner", "-i", str(source)], capture_output=True, text=True)
    duration_match = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", probe.stderr)
    if not duration_match:
        raise ValueError("Cannot verify source duration.")
    hours, minutes, seconds = map(float, duration_match.groups())
    duration = hours * 3600 + minutes * 60 + seconds
    if not 4 <= duration <= 60:
        raise ValueError("Unexpected source duration.")
    private = ROOT / ".local"
    private.mkdir(exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="aelune-frames-", dir=private))
    result = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(source),
                             "-an", "-vf", "fps=18,scale='min(720,iw)':-2", "-c:v", "libwebp",
                             "-quality", "80", "-compression_level", "5", "-start_number", "0",
                             str(staging / "frame-%04d.webp")], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("Frame extraction failed; staging directory is preserved for inspection.")
    frames = sorted(staging.glob("frame-*.webp"))
    if not 2 <= len(frames) <= 1200:
        raise ValueError("Unexpected extracted frame count.")
    with Image.open(frames[0]) as first:
        width, height = first.size
    manifest = {"version": 1, "width": width, "height": height, "frameCount": len(frames),
                "durationSeconds": duration, "fps": 18, "poster": "/media/aelune/drop-poster.webp",
                "frames": [f"/media/aelune/story/{p.name}" for p in frames],
                "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest()}
    (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    staging.rename(TARGET)
    review = Image.new("RGB", (5 * 180, 2 * 350), "#eaf5fb")
    draw = ImageDraw.Draw(review)
    for tile in range(10):
        index = min(len(frames) - 1, round(tile * (len(frames) - 1) / 9))
        with Image.open(TARGET / f"frame-{index:04d}.webp") as image:
            image.thumbnail((180, 320))
            x, y = tile % 5 * 180, tile // 5 * 350
            review.paste(image, (x, y))
            draw.text((x + 8, y + 325), f"{index / 18:.1f}s / frame {index}", fill="#11262f")
    review.save(private / "aelune/story-contact-sheet.jpg", quality=88)
    print(json.dumps(verify(), indent=2))


if __name__ == "__main__":
    main()
