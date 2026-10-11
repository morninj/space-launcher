#!/usr/bin/env python3
"""Download Webb photographs into src/webb/ for the new tab page.

Three sources, all of which file charts, artwork and annotated versions in
among the photographs:

- ESA/Webb (esawebb.org/images): entries whose type is "Observation".
- NASA (science.nasa.gov/mission/webb/multimedia/images): entries tagged as
  Webb images and not as side-by-sides, infographics or engineering, with
  titles that name a Webb instrument. ESA labels a good many clean photos
  "Collage" or nothing at all, and NASA has most of those, labelled properly.
- Wikimedia Commons (Category:Images by the James Webb Space Telescope): only
  the work of independent processors, who build pictures from Webb's public
  data that neither agency publishes. The rest of Commons is copies of the
  agencies' pictures, event photography and graphics.

The sources share many releases, and copies of one release are the same size
to the pixel, so a photo matching one already taken is skipped.

Every photo sharp enough is kept whole, saved just big enough to cover a 6K
screen. The big mosaics are also cut into close-ups at full resolution, which
is where most of the collection comes from: one of them can be dozens of
screens across. A close-up of empty sky is skipped.

Alongside the photos it writes src/webb/catalog.js, which the page loads to
pick one, and it deletes photos no longer in it. Resumable: whatever the last
catalog lists and is still on disk is kept, so a rerun only fetches what's new.
Resizing uses macOS `sips`.

    python3 scripts/fetch-webb.py
"""

import html
import json
import re
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SITE = "https://esawebb.org"
CDN = "https://cdn.esawebb.org/archives/images"
NASA = "https://science.nasa.gov/wp-json/wp/v2"
NASA_WEBB = 2881  # the category NASA files Webb's assets under
COMMONS = "https://commons.wikimedia.org/w/api.php"
COMMONS_ROOT = "Category:Images by the James Webb Space Telescope"
OUT = Path(__file__).resolve().parent.parent / "src" / "webb"
# The screen a photo has to fill, in device pixels: a Pro Display XDR. The page
# crops to cover, so a photo is kept down to whichever side meets this first.
SCREEN = (6016, 3384)
# How much of that a whole photo must cover before upscaling, on its weaker
# side. Half is visibly soft up close, but holds up as a background.
SHARP = 0.5
# Close-ups are cut at full resolution, screen-sized, on a grid whose steps
# overlap by a quarter. A photo gives at most this many, the busiest first.
CLOSEUPS = 10
STEP = 0.75
WORKERS = 4
UA = {"User-Agent": "space-launcher-fetch-webb/0.2 (new-tab extension; github.com/morninj/space-launcher)"}

# Decoding a big mosaic takes gigabytes; one at a time.
huge = threading.Lock()
HUGE = 150_000_000  # pixels


def get(url, tries=6):
    for attempt in range(tries):
        try:
            request = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(request, timeout=300) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == tries - 1:
                raise
            time.sleep(int(error.headers.get("Retry-After") or 10) * (attempt + 1))


def text(fragment):
    """Markup to plain text: tags dropped, entities decoded, space collapsed."""
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", fragment))).strip()


def first_sentence(paragraph, limit=220):
    match = re.match(r"(.+?[.!?])(\s+[A-Z]|$)", paragraph)
    sentence = match.group(1) if match else paragraph
    if len(sentence) > limit:
        sentence = sentence[: limit - 1].rsplit(" ", 1)[0] + "…"
    return sentence


MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]


def day(iso):
    """2026-10-06… as 6 October 2026."""
    return f"{int(iso[8:10])} {MONTHS[int(iso[5:7]) - 1]} {iso[:4]}"


def cover(w, h):
    """How much of the screen a w×h photo fills, cropped to cover, unscaled."""
    return min(w / SCREEN[0], h / SCREEN[1])


# Titles that give away a chart, a comparison or a marked-up copy.
NOT_A_PHOTO = re.compile(
    r"compass|annotat|illustrat|artist|concept|spectr|graphic|side.by.side|pull.?out|"
    r"label|diagram|chart|comparison|transit|light curve|animation|video|timeline|"
    r"before and after|scale bar|graph|circled|collage|cutout|location of|"
    r"calendar|cover page|briefing|unveil|times square|broadcast|"
    r"phase curve|molecules|methane|atmospher|instrument",  # NASA's data plots, hardware
    re.I,
)
INSTRUMENT = re.compile(r"NIRCam|MIRI|NIRSpec|NIRISS|\(Webb", re.I)


def hubble_only(title):
    hubble = re.search(r"Hubble|\bHST\b", title)
    return bool(hubble) and not re.search(r"Webb|JWST", title) and not INSTRUMENT.search(title)


# Sizing, cropping and saving.


def sips(*args):
    return subprocess.run(["sips", *map(str, args)], check=True, capture_output=True, text=True).stdout


def dimensions(path):
    return tuple(int(n) for n in re.findall(r"pixel(?:Width|Height): (\d+)", sips("-g", "pixelWidth", "-g", "pixelHeight", path)))


def luminance(path, w, h):
    """A coarse grey map of the photo, a cell per ~quarter screen, via BMP."""
    cols = max(1, round(w / SCREEN[0] * 8))
    rows = max(1, round(h / SCREEN[1] * 8))
    with tempfile.TemporaryDirectory() as scratch:
        bmp = Path(scratch) / "map.bmp"
        sips("-s", "format", "bmp", "-z", rows, cols, path, "--out", bmp)
        data = bmp.read_bytes()
    offset, = struct.unpack_from("<I", data, 10)
    bw, bh = struct.unpack_from("<ii", data, 18)
    depth = struct.unpack_from("<H", data, 28)[0] // 8
    stride = (bw * depth + 3) & ~3
    grid = []
    for y in range(abs(bh)):
        row = y if bh < 0 else abs(bh) - 1 - y  # positive height is bottom-up
        base = offset + row * stride
        grid.append([
            0.114 * data[base + x * depth] + 0.587 * data[base + x * depth + 1] + 0.299 * data[base + x * depth + 2]
            for x in range(bw)
        ])
    return grid


def closeups(w, h, grid):
    """Screen-sized windows onto a big photo, busiest first, empty sky dropped."""
    cw, ch = SCREEN

    def starts(total, size):
        if total < size:
            return []
        n = int((total - size) / (size * STEP)) + 1
        spare = total - size - (n - 1) * size * STEP
        return [round(spare / 2 + i * size * STEP) for i in range(n)]

    windows = [(x, y) for y in starts(h, ch) for x in starts(w, cw)]
    if len(windows) < 2:  # one window is just the whole photo again
        return []
    gh, gw = len(grid), len(grid[0])
    scored = []
    for x, y in windows:
        cells = [
            grid[gy][gx]
            for gy in range(int(y / h * gh), max(int(y / h * gh) + 1, int((y + ch) / h * gh)))
            for gx in range(int(x / w * gw), max(int(x / w * gw) + 1, int((x + cw) / w * gw)))
        ]
        mean = sum(cells) / len(cells)
        spread = (sum((c - mean) ** 2 for c in cells) / len(cells)) ** 0.5
        # Busy means structure: nebula, galaxies, stars. A dark, flat window is
        # the empty edge of a mosaic, or sky with nothing much in it.
        if mean < 10 or spread < 6:
            continue
        scored.append((spread + mean / 4, x, y))
    scored.sort(reverse=True)
    return [(x, y) for _, x, y in scored[:CLOSEUPS]]


def emit(source, entry):
    """Save a downloaded photo whole and in close-ups; the catalog entries."""
    w, h = dimensions(source)
    lock = huge if w * h > HUGE else threading.Lock()
    saved = []
    with lock:
        if cover(w, h) >= SHARP:
            scale = min(1, max(SCREEN[0] / w, SCREEN[1] / h))
            sips("-s", "format", "jpeg", "-s", "formatOptions", 82,
                 "-z", round(h * scale), round(w * scale), source, "--out", OUT / f"{entry['id']}.jpg")
            saved.append(dict(entry))
        spots = closeups(w, h, luminance(source, w, h)) if w >= SCREEN[0] * 2 or h >= SCREEN[1] * 2 else []
        for n, (x, y) in enumerate(spots, 1):
            piece = dict(entry, id=f"{entry['id']}~{n}", title=f"{entry['title']} (detail)")
            sips("-s", "format", "jpeg", "-s", "formatOptions", 82,
                 "-c", SCREEN[1], SCREEN[0], "--cropOffset", y, x, source, "--out", OUT / f"{piece['id']}.jpg")
            saved.append(piece)
    return saved


def cached(group, previous):
    """The entries a group produced last time, if all its files survive."""
    entries = previous.get(group)
    if entries and all((OUT / f"{e['id']}.jpg").exists() for e in entries):
        return entries
    return None


def guarded(work, label):
    try:
        return work()
    except Exception as error:
        print(f"  {label}: {error}", file=sys.stderr)
        return []


# ESA/Webb.


def esa_listing():
    """Every ESA entry, with the size of its original."""
    sizes = {}
    page = 1
    while True:
        try:
            body = get(f"{SITE}/images/page/{page}/").decode()
        except urllib.error.HTTPError as error:
            if error.code == 404:  # past the last page
                return sizes
            raise
        found = re.findall(r"id: '([^']+)',.*?width: (\d+),\s*height: (\d+)", body, re.S)
        if not found:
            return sizes
        for image_id, w, h in found:
            sizes.setdefault(image_id, (int(w), int(h)))
        page += 1


def esa_details(image_id):
    body = get(f"{SITE}/images/{image_id}/").decode()
    kind = re.search(r"Type:\s*</t[hd]>\s*<td[^>]*>(.*?)</td>", body, re.S)
    if not kind or "Observation" not in text(kind.group(1)):
        return None
    title = text(re.search(r"<h1[^>]*>(.*?)</h1>", body, re.S).group(1))
    # ESA's "Observation" still takes in marked-up copies, and Hubble's own
    # pictures of Webb's targets.
    if NOT_A_PHOTO.search(title) or hubble_only(title):
        return None
    # The description is the run of paragraphs between the image and the
    # credit line; the first one says what the picture is.
    paragraphs = re.findall(r"<p>(?!<p>)(.*?)</p>", body.split("<strong>Credit:</strong>")[0], re.S)
    paragraphs = [text(p) for p in paragraphs]
    paragraphs = [p for p in paragraphs if len(p) > 60 and not p.startswith("[")]
    credit = re.search(r'<div class="credit">(.*?)</div>', body, re.S)
    date = re.search(r"Release date:\s*</t[hd]>\s*<td[^>]*>(.*?)</td>", body, re.S)
    return {
        "id": image_id,
        "source": "esa",
        "title": title,
        "blurb": first_sentence(paragraphs[0]) if paragraphs else "",
        "credit": text(credit.group(1)) if credit else "ESA/Webb, NASA & CSA",
        "date": text(date.group(1)).split(",")[0] if date else "",
        "url": f"{SITE}/images/{image_id}/",
    }


def esa_fetch(image_id, previous):
    def work():
        hit = cached(image_id, previous)
        if hit is not None:
            return hit
        entry = esa_details(image_id)
        if not entry:
            return []
        # "large" is usually the full-size original, but for some entries it
        # is a small preview, and the publication JPEG (~4K) is the bigger of
        # the two. Not every entry has either, so the screen size is the last
        # resort.
        with tempfile.TemporaryDirectory() as scratch:
            best = None
            for size in ("large", "publicationjpg", "screen"):
                try:
                    data = get(f"{CDN}/{size}/{image_id}.jpg")
                except Exception:
                    continue
                path = Path(scratch) / f"{size}.jpg"
                path.write_bytes(data)
                w, h = dimensions(path)
                if not best or w * h > best[1] * best[2]:
                    best = (path, w, h)
                if w >= SCREEN[0] and h >= SCREEN[1]:
                    break
            return emit(best[0], entry) if best else []

    return guarded(work, image_id)


# NASA.

NOT_PHOTO_TAGS = {
    "science-org-webb-images-side-by-side",
    "science-org-webb-images-infographic",
    "science-org-webb-images-engineering",
    "category-es",  # the Spanish copy of an English entry
}


def nasa_listing():
    """NASA's Webb photos, with the size and address of each original."""
    records = []
    page = 1
    while True:
        try:
            batch = json.loads(get(
                f"{NASA}/stma?categories={NASA_WEBB}&per_page=100&page={page}"
                "&_fields=date,slug,link,title,excerpt,class_list,featured_media"
            ))
        except urllib.error.HTTPError as error:
            if error.code == 400:  # past the last page
                break
            raise
        if not batch:
            break
        records += batch
        page += 1
    records = [
        r for r in records
        if "science-org-webb-images" in r["class_list"]
        and not NOT_PHOTO_TAGS & set(r["class_list"])
        and INSTRUMENT.search(text(r["title"]["rendered"]))
        and not NOT_A_PHOTO.search(text(r["title"]["rendered"]))
        and r["featured_media"]
    ]
    media = {}
    ids = [r["featured_media"] for r in records]
    for i in range(0, len(ids), 100):
        for m in json.loads(get(
            f"{NASA}/media?per_page=100&include={','.join(map(str, ids[i:i + 100]))}"
            "&_fields=id,source_url,media_details"
        )):
            media[m["id"]] = m
    photos = []
    for r in records:
        m = media.get(r["featured_media"])
        if not m or not m["media_details"].get("width"):
            continue
        details = m["media_details"]
        photos.append({
            "id": "nasa-" + r["slug"],
            "source": "nasa",
            "title": text(r["title"]["rendered"]),
            "blurb": first_sentence(text(r["excerpt"]["rendered"])),
            "credit": re.sub(r"^Image:\s*", "", text(details.get("credits") or "NASA, ESA, CSA, STScI")),
            "date": day(r["date"]),
            "url": r["link"],
            "original": m["source_url"],
            "size": (details["width"], details["height"]),
        })
    return photos


def nasa_fetch(photo, previous):
    def work():
        hit = cached(photo["id"], previous)
        if hit is not None:
            return hit
        # The listed address is a resizing service that stops at 1280px.
        # Behind it sits the original, often a PNG of a few hundred megabytes,
        # and beside that a full-size JPEG rendition a fraction of the weight;
        # take that one.
        original = photo["original"].replace("/dynamicimage/assets/science/", "/content/dam/science/")
        w, h = photo["size"]
        entry = {k: v for k, v in photo.items() if k not in ("original", "size")}
        with tempfile.TemporaryDirectory() as scratch:
            for url in (f"{original}/jcr:content/renditions/{w}x{h}.jpg", original):
                try:
                    data = get(url)
                    break
                except Exception:
                    data = None
            if not data:
                return []
            path = Path(scratch) / ("original" + Path(url).suffix)
            path.write_bytes(data)
            return emit(path, entry)

    return guarded(work, photo["id"])


# Wikimedia Commons.

# Whose work to take: people processing Webb's public data themselves.
PROCESSORS = re.compile(
    r"Th[ée]venot|McCaughrean|geckzilla|Judy Schmidt|Kevin M\.? Gill|Joxean Koret", re.I
)
# Subcategories with nothing to take from.
NOT_PHOTO_CATEGORIES = re.compile(
    r"Video|Engineering|Self-portrait|Comparison|Commissioning|calendar|Spectr|"
    r"Diagram|Illustrat|Artist|Chart|Infographic|Animation|annotat|Graph",
    re.I,
)


def commons(**params):
    params.update(format="json", formatversion=2, maxlag=5)
    time.sleep(1)  # Commons asks to be called gently
    return json.loads(get(COMMONS + "?" + urllib.parse.urlencode(params)))


# Commons descriptions are whatever the processor wrote: often a subject, then
# filters and program numbers, and often a Flickr post in the first person. Keep
# the subject; anything chatty or bare gets a plain line instead.
CHATTY = re.compile(r"^(yes|thanks|finally|update|it's|this got|the thing|i\b|i'\w)|\b(I|I've|I'm|me|my)\b", re.I)
TECHNICAL = re.compile(r"[\s,]+(?:(?:with|by|from|taken by)\s+)?(?:the\s+)?(?:JWST|James Webb)(?:\s+Telescope)?(?=[\s,]+(?:NIRCam|MIRI|image|Filters?|program|Proposal|NIR\b|using))"
                       r"|,?\s+(?:as\s+)?made using\b.*|\s+Image Credit\b.*"
                       r"|[\s,]+(?:Filters?:?\s+F\d|program(?: id)?:|Proposal id\b|PI:|FITS\b).*", re.I)
RUN_ON = re.compile(r"(?<=[0-9a-z)])\s+(?=(?:These are|This is|It is) )")  # a missing full stop

def commons_blurb(description, title):
    sentence = first_sentence(description)
    subject = re.sub(r" \(SIMBAD\)|\s+–[^–]*µm[^–]*–", "", sentence)  # wavelengths aside
    subject = RUN_ON.split(subject, 1)[0]
    subject = TECHNICAL.split(subject, 1)[0].strip(" ,.:–-")
    plain = "Processed independently from Webb's public data."
    if (CHATTY.search(sentence) or len(subject) < 20 or re.match(r"(JWST Proposal|NASA /)", subject)
            or subject.lower() in title.lower() or title.lower() in subject.lower()):
        return plain
    return subject[0].upper() + subject[1:] + ("" if subject.endswith("…") else ".")


def commons_listing():
    files, seen, frontier = set(), set(), [COMMONS_ROOT]
    while frontier:
        category = frontier.pop()
        if category in seen:
            continue
        seen.add(category)
        more = {}
        while True:
            batch = commons(action="query", list="categorymembers", cmtitle=category,
                            cmlimit=500, cmtype="subcat|file", **more)
            for member in batch["query"]["categorymembers"]:
                if member["ns"] == 14 and not NOT_PHOTO_CATEGORIES.search(member["title"]):
                    frontier.append(member["title"])
                elif member["ns"] == 6:
                    files.add(member["title"])
            if "continue" not in batch:
                break
            more = batch["continue"]
    files = sorted(files)
    photos = []
    for i in range(0, len(files), 50):
        batch = commons(action="query", prop="imageinfo", titles="|".join(files[i:i + 50]),
                        iiprop="size|mime|url|extmetadata",
                        iiextmetadatafilter="ImageDescription|Artist|LicenseShortName|DateTimeOriginal")
        for page in batch["query"]["pages"]:
            info = (page.get("imageinfo") or [None])[0]
            if not info or info["mime"] not in ("image/jpeg", "image/png", "image/tiff"):
                continue
            meta = {k: text(str(v.get("value", ""))) for k, v in info.get("extmetadata", {}).items()}
            artist = meta.get("Artist", "")
            title = re.sub(r"\.\w+$", "", page["title"].removeprefix("File:"))
            title = re.sub(r"\s*\(\d{9,}\)$|\s*-\s*\d{9,}$", "", title)  # Flickr IDs
            if not PROCESSORS.search(artist) or NOT_A_PHOTO.search(title):
                continue
            slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
            date = meta.get("DateTimeOriginal", "")
            photos.append({
                "id": "commons-" + slug[:80],
                "source": "commons",
                "title": title,
                "blurb": commons_blurb(meta.get("ImageDescription", ""), title),
                "credit": f"{artist} · {meta.get('LicenseShortName', '')}".strip(" ·"),
                "date": day(date) if re.match(r"\d{4}-\d\d-\d\d", date) else "",
                "url": info["descriptionurl"],
                "original": info["url"],
                "size": (info["width"], info["height"]),
            })
    return photos


def commons_fetch(photo, previous):
    def work():
        hit = cached(photo["id"], previous)
        if hit is not None:
            return hit
        entry = {k: v for k, v in photo.items() if k not in ("original", "size")}
        with tempfile.TemporaryDirectory() as scratch:
            path = Path(scratch) / ("original" + Path(photo["original"]).suffix)
            path.write_bytes(get(photo["original"]))
            return emit(path, entry)

    return guarded(work, photo["id"])


# Putting it together.


def worth_taking(photos, taken):
    """Photos big enough for a whole view or close-ups, and not had already."""
    keep = []
    ids = set()
    for photo in photos:
        size = tuple(photo["size"])
        if cover(*size) < SHARP or size in taken or photo["id"] in ids:
            continue
        taken.add(size)
        ids.add(photo["id"])
        keep.append(photo)
    return keep


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    previous = {}
    try:
        source = (OUT / "catalog.js").read_text()
        for entry in json.loads(source[source.index("["):source.rindex("]") + 1]):
            previous.setdefault(entry["id"].split("~")[0], []).append(entry)
    except (FileNotFoundError, ValueError):
        pass

    catalog = []
    sizes = esa_listing()
    candidates = [i for i, size in sizes.items() if cover(*size) >= SHARP]
    print(f"ESA: {len(sizes)} listed, {len(candidates)} big enough to check")
    with ThreadPoolExecutor(WORKERS) as pool:
        groups = list(pool.map(lambda i: esa_fetch(i, previous), candidates))
    taken = {sizes[i] for i, group in zip(candidates, groups) if group}
    catalog += [e for group in groups for e in group]
    print(f"  {len(catalog)} photos")

    # The same release is the same size to the pixel in every archive; two
    # different photos that happen to be are rare.
    photos = worth_taking(nasa_listing(), taken)
    print(f"NASA: {len(photos)} not already taken")
    with ThreadPoolExecutor(WORKERS) as pool:
        found = [e for group in pool.map(lambda p: nasa_fetch(p, previous), photos) for e in group]
    catalog += found
    print(f"  {len(found)} photos")

    photos = worth_taking(commons_listing(), taken)
    print(f"Commons: {len(photos)} not already taken")
    found = [e for p in photos for e in commons_fetch(p, previous)]  # one at a time, as asked
    catalog += found
    print(f"  {len(found)} photos")

    keep = {f"{e['id']}.jpg" for e in catalog}
    stale = [f for f in OUT.glob("*.jpg") if f.name not in keep]
    for f in stale:
        f.unlink()
    (OUT / "catalog.js").write_text(
        "// Written by scripts/fetch-webb.py.\nconst WEBB = "
        + json.dumps(catalog, ensure_ascii=False, indent=1)
        + ";\n"
    )
    print(f"{len(catalog)} photos in {OUT}, {len(stale)} old ones removed")


if __name__ == "__main__":
    main()
