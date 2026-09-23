#!/usr/bin/env python3
"""Snapshot the Launcher's saved links into ./backups.

The extension cannot write here itself — chrome.downloads is confined to the
downloads folder — so this reads Chrome's own storage for the extension and
writes a copy whenever the content has changed. Chrome holds a lock on those
LevelDB directories while it runs, so they are copied first and read from the
copy; the values are plain JSON sitting in the log, which is what makes this
possible without a LevelDB library.

Run by launchd every few minutes; safe to run by hand at any time.
"""

import base64
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BACKUPS = REPO / "backups"
KEEP = 60  # snapshots to retain; only changes are written, so this is deep
BLOCK = 32768


def extension_id():
    """The ID Chrome derives from the manifest's key — the folder to look in."""
    key = json.loads((REPO / "src" / "manifest.json").read_text())["key"]
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def storage_dirs(ext_id):
    """Every Chrome profile's store for this extension, newest written first."""
    roots = [
        Path.home() / "Library/Application Support/Google/Chrome",
        Path.home() / "Library/Application Support/Google/Chrome Beta",
        Path.home() / "Library/Application Support/Google/Chrome Canary",
    ]
    found = []
    for root in roots:
        if not root.is_dir():
            continue
        for kind in ("Sync Extension Settings", "Local Extension Settings"):
            for path in root.glob(f"*/{kind}/{ext_id}"):
                if path.is_dir():
                    found.append(path)
    return sorted(found, key=lambda p: max((f.stat().st_mtime for f in p.iterdir()), default=0), reverse=True)


def records(raw):
    """Reassemble leveldb log records, dropping the per-block headers."""
    out, buf, pos = [], b"", 0
    while pos + 7 <= len(raw):
        off = pos % BLOCK
        if BLOCK - off < 7:
            pos += BLOCK - off
            continue
        length = int.from_bytes(raw[pos + 4 : pos + 6], "little")
        rtype = raw[pos + 6]
        data = raw[pos + 7 : pos + 7 + length]
        pos += 7 + length
        if rtype == 1:
            out.append(data)
        elif rtype == 2:
            buf = data
        elif rtype == 3:
            buf += data
        elif rtype == 4:
            out.append(buf + data)
            buf = b""
    return out


def link_arrays(text):
    """Balanced [...] runs that parse as a list of links."""
    for m in re.finditer(r'\[\{"(?:id|title|url|children|collapsed)":', text):
        i, depth, in_str, esc = m.start(), 0, False, False
        for j in range(i, len(text)):
            c = text[j]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            else:
                if c == '"':
                    in_str = True
                elif c in "[{":
                    depth += 1
                elif c in "]}":
                    depth -= 1
                    if depth == 0:
                        try:
                            data = json.loads(text[i : j + 1])
                        except ValueError:
                            pass
                        else:
                            if isinstance(data, list) and data and all(
                                isinstance(x, dict) and "id" in x for x in data
                            ):
                                yield data
                        break


def newest_links(store):
    """The last links value written in this store, or None."""
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / "store"
        shutil.copytree(store, copy)  # Chrome is holding the original open
        files = sorted(copy.iterdir(), key=lambda f: f.stat().st_mtime, reverse=True)
        for path in files:
            if path.suffix not in (".log", ".ldb") or not path.is_file():
                continue
            raw = path.read_bytes()
            chunks = records(raw) if path.suffix == ".log" else [raw]
            # Later writes win: the log is append-only, so scan from the end.
            for chunk in reversed(chunks):
                found = list(link_arrays(chunk.decode("utf-8", "replace")))
                if found:
                    return max(found, key=lambda d: len(json.dumps(d)))
    return None


def count(links):
    return sum(1 + count(l.get("children", [])) for l in links)


def main():
    ext_id = extension_id()
    stores = storage_dirs(ext_id)
    if not stores:
        print(f"no Chrome storage found for {ext_id}; nothing to back up")
        return 0

    links = None
    for store in stores:
        links = newest_links(store)
        if links:
            break
    if not links:
        print("storage found but no links in it yet")
        return 0

    BACKUPS.mkdir(exist_ok=True)
    body = json.dumps(links, indent=2) + "\n"
    existing = sorted(BACKUPS.glob("links-*.json"))
    if existing and existing[-1].read_text() == body:
        return 0  # unchanged since the last snapshot

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = BACKUPS / f"links-{stamp}.json"
    out.write_text(body)
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} wrote {out.name} — {count(links)} links")

    for old in sorted(BACKUPS.glob("links-*.json"))[:-KEEP]:
        old.unlink()
    return 0


if __name__ == "__main__":
    sys.exit(main())
