#!/usr/bin/env python3
"""Package the extension for the Chrome Web Store, as dist/space-launcher-<version>.zip.

The full photo set is gigabytes, far past what belongs in a store package, so
the build carries the curated list in store/photos.txt, each photo scaled down
to cover a 4K screen. Everything else in src/ goes in as it is, except the
manifest's `key`: the store assigns its own ID and rejects a package that
names one. The key stays in src/ so an unpacked copy keeps its ID, and with
it its saved links.

Needs the photos on disk first: python3 scripts/fetch-webb.py. macOS only, for
sips.
"""

import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "src"
DIST = REPO / "dist"
STAGE = DIST / "space-launcher"
SCREEN = (3840, 2160)  # what the store photos are scaled to cover
QUALITY = 60  # star fields are noise to a JPEG; past this is size, not sharpness


def size(path):
    out = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
                         check=True, capture_output=True, text=True).stdout
    return tuple(int(re.search(rf"{k}: (\d+)", out).group(1)) for k in ("pixelWidth", "pixelHeight"))


def main():
    wanted = [line.split("#")[0].strip() for line in (REPO / "store" / "photos.txt").read_text().splitlines()]
    wanted = [id for id in wanted if id]
    source = (SRC / "webb" / "catalog.js").read_text() if (SRC / "webb" / "catalog.js").exists() else "[]"
    catalog = {e["id"]: e for e in json.loads(source[source.index("["):source.rindex("]") + 1])}
    missing = [id for id in wanted if id not in catalog or not (SRC / "webb" / f"{id}.jpg").exists()]
    if missing:
        sys.exit(f"not in src/webb (run scripts/fetch-webb.py?): {', '.join(missing)}")

    shutil.rmtree(STAGE, ignore_errors=True)
    shutil.copytree(SRC, STAGE, ignore=shutil.ignore_patterns("webb", ".DS_Store"))
    manifest = json.loads((STAGE / "manifest.json").read_text())
    manifest.pop("key", None)
    (STAGE / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")

    (STAGE / "webb").mkdir()
    for n, id in enumerate(wanted, 1):
        original, out = SRC / "webb" / f"{id}.jpg", STAGE / "webb" / f"{id}.jpg"
        w, h = size(original)
        scale = max(SCREEN[0] / w, SCREEN[1] / h)
        args = ["--resampleWidth", round(w * scale)] if scale < 1 else []
        subprocess.run(["sips", *map(str, args), "-s", "formatOptions", str(QUALITY), original, "--out", out],
                       check=True, capture_output=True)
        print(f"\r  photos {n}/{len(wanted)}", end="", flush=True)
    print()
    entries = [catalog[id] for id in wanted]
    (STAGE / "webb" / "catalog.js").write_text(
        "// The store build's photos: see store/photos.txt.\nconst WEBB = "
        + json.dumps(entries, ensure_ascii=False, indent=1) + ";\n")

    archive = DIST / f"space-launcher-{manifest['version']}.zip"
    archive.unlink(missing_ok=True)
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(STAGE.rglob("*")):
            if path.is_file():
                # JPEGs are already compressed; deflating them again buys nothing
                kind = zipfile.ZIP_STORED if path.suffix == ".jpg" else zipfile.ZIP_DEFLATED
                z.write(path, path.relative_to(STAGE), compress_type=kind)
    print(f"  {archive.relative_to(REPO)}: {len(entries)} photos, {archive.stat().st_size / 1e6:.0f} MB")
    print(f"  to try it first: Load unpacked → {STAGE.relative_to(REPO)}")


if __name__ == "__main__":
    main()
