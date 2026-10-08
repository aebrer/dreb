#!/usr/bin/env python3
"""Development-only acquisition/build/verification of PR540's Latin font catalog.

From the repository root (Python 3.14 used for the checked-in build):
  python3 -m venv /tmp/dreb-fonts-venv
  /tmp/dreb-fonts-venv/bin/pip install fonttools==4.63.0 brotli==1.2.0
  /tmp/dreb-fonts-venv/bin/python packages/dashboard/scripts/build-font-catalog.py
  /tmp/dreb-fonts-venv/bin/python packages/dashboard/scripts/build-font-catalog.py --verify

Normal builds verify every download against sources.lock.json and verify generated
binary hashes against catalog.json BEFORE writing anything. --verify is offline.
--bootstrap creates the initial source lock ONLY when it does not already exist.
--refresh-acquisition requires --backup-dir outside the repo and an existing lock;
shared source hashes must still match, and obsolete generated assets are removed
only after acquisition succeeds. Both acquisition modes require
--selection-snapshot /tmp/pr540-font-work/popularity.json (approved SHA/date).
Never fetch changing popularity ordering. --cache-dir may point to a temporary
download cache; cached bytes are hash-checked. --offline rebuild never downloads.
No Python or acquisition runs at runtime.
"""

import argparse
import hashlib
import io
import json
import logging
import re
import shutil
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from importlib.metadata import version
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

COMMIT = "9710da1eacb3be272583c3224dcb70f9da6eadbb"
BASE = f"https://raw.githubusercontent.com/google/fonts/{COMMIT}/"
POPULARITY_URL = "https://fonts.google.com/metadata/fonts"
SELECTION_DATE = "2026-10-02"
EXISTING_BYTES = 1_395_464
ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "src/client/assets/fonts/expanded"
CSS = ROOT / "src/client/styles/font-catalog.css"
SANS = ["Roboto", "Open Sans", "Google Sans", "Inter", "Montserrat", "Poppins",
        "Lato", "Roboto Condensed", "Arimo", "Noto Sans", "DM Sans", "Raleway",
        "Nunito", "Nunito Sans", "Rubik"]
SERIF = ["Playfair Display", "Merriweather", "Lora", "Noto Serif",
         "Cormorant Garamond", "Libre Baskerville", "PT Serif", "EB Garamond",
         "Fraunces", "Bitter", "Source Serif 4", "Newsreader", "Crimson Text",
         "Arvo", "Bodoni Moda"]
POPULARITY_SHA256 = "0c4c0412a092525c7e82bcef498c74993b4ec983b915cd321aa3545f09c60b00"
REPLACEMENT_RANKS = {"Rubik": 29, "Crimson Text": 133, "Arvo": 143, "Bodoni Moda": 156}
REQUESTED = set(range(0x250)) | set(range(0x300, 0x370)) | set(range(0x2000, 0x27C0))
IDENTITY_IDS = {1, 2, 3, 4, 6, 16, 17, 18, 20, 21, 22, 25}
NOTICE_IDS = {0, 7, 13, 14}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded_url(path):
    return BASE + urllib.parse.quote(path, safe="/")


def families():
    for kind, labels, group in [("Sans", SANS, "Sans-serif"), ("Serif", SERIF, "Serif")]:
        for index, label in enumerate(labels, 1):
            slug = re.sub(r"(?<=[a-zA-Z])(?=4)", "-", label.lower()).replace(" ", "-")
            folder = "ofl/" + label.lower().replace(" ", "")
            # PT Serif's RFNs include the word Serif; keep derivative names free
            # of every reserved word, not only the complete upstream family.
            derivative_kind = "Text" if label == "PT Serif" else kind
            yield {"id": slug, "label": label, "group": group,
                   "family": f"Dreb {derivative_kind} {index:02}",
                   "stem": f"latin-{kind.lower()}-{index:02}", "folder": folder}


def download(url):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as response:
                return response.read()
        except (OSError, TimeoutError):
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


class Sources:
    def __init__(self, bootstrap, cache, refresh=False, offline=False):
        self.bootstrap = bootstrap
        self.refresh = refresh
        self.offline = offline
        self.cache = cache
        lock = ASSETS / "sources.lock.json"
        if bootstrap:
            require(not lock.exists(), "Refusing to bootstrap over an existing source lock")
            self.records = {}
        else:
            require(lock.exists(), "Missing source lock; initial acquisition requires --bootstrap")
            contents = json.loads(lock.read_text())
            require(contents["commit"] == COMMIT, "Source revision mismatch")
            self.records = contents["sources"]
        self.used = set()
        self.outputs = {}

    def get(self, path, local=None):
        url = encoded_url(path)
        expected = self.records.get(path)
        require(self.bootstrap or self.refresh or expected is not None, f"Unpinned source: {path}")
        target = self.cache / path
        # Newly acquired sources must come from the pinned URL, never from an
        # untrusted/unpinned pre-existing cache entry. Shared sources stay pinned.
        if expected is None or not target.exists():
            require(not self.offline, f"Offline source missing/unpinned: {path}")
            data = download(url)
            if expected is None and target.exists():
                require(target.read_bytes() == data, f"Unpinned cache differs from pinned upstream: {path}")
        else:
            data = target.read_bytes()
        record = {"url": url, "sha256": sha(data), "bytes": len(data)}
        if expected is not None:
            require(record == expected, f"Source hash/URL/size mismatch: {path}")
        else:
            self.records[path] = record
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        self.used.add(path)
        if local:
            self.outputs[ASSETS / local] = data
        return data, record

    def lock(self):
        if not self.refresh:
            require(self.used == set(self.records), "Unused/missing sources in lock")
        return {"commit": COMMIT, "sources": {path: self.records[path] for path in sorted(self.used)}}


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()


def ranges(points):
    result = []
    for point in sorted(points):
        if result and point == result[-1][1] + 1:
            result[-1][1] = point
        else:
            result.append([point, point])
    return [f"U+{start:04X}" if start == end else f"U+{start:04X}-{end:04X}"
            for start, end in result]


def expand_ranges(values):
    result = set()
    for value in values:
        match = re.fullmatch(r"U\+([0-9A-F]{4,6})(?:-([0-9A-F]{4,6}))?", value)
        require(match is not None, f"Invalid coverage range: {value}")
        start = int(match[1], 16)
        end = int(match[2], 16) if match[2] else start
        result.update(range(start, end + 1))
    return result


def parse_faces(metadata):
    # The font blocks at this pinned revision have no nested messages.
    result = []
    for block in re.findall(r"^fonts \{\n(.*?)^\}", metadata, flags=re.M | re.S):
        def field(key):
            match = re.search(rf'^  {key}: "([^"]+)"$', block, flags=re.M)
            require(match is not None, f"Missing {key} in font metadata")
            return match[1]
        weight = re.search(r"^  weight: (\d+)$", block, flags=re.M)
        require(weight is not None, "Missing weight in metadata")
        result.append({"filename": field("filename"), "style": field("style"),
                       "weight": int(weight[1])})
    require(result, "No font faces in metadata")
    return result


def selected_faces(faces):
    selected = []
    for style in ("normal", "italic"):
        candidates = [face for face in faces if face["style"] == style]
        variable = [face for face in candidates if "[" in face["filename"]]
        if variable:
            require(len(variable) == len(candidates) == 1,
                    f"Ambiguous {style} variable face")
            require("wght" in variable[0]["filename"], f"No {style} weight axis in metadata")
            selected.extend(variable)
        else:
            by_weight = {face["weight"]: face for face in candidates}
            require(len(by_weight) == len(candidates), f"Ambiguous static {style} weights")
            require({400, 700} <= by_weight.keys(), f"Missing real {style} 400/700")
            weights = [400] + ([weight for weight in (500, 600) if weight in by_weight]
                               if style == "normal" else []) + [700]
            selected.extend(by_weight[weight] for weight in weights)
    return selected


def validate_source_face(font, face):
    require(bool(font["OS/2"].fsSelection & 1) == (face["style"] == "italic"),
            f"Upstream TTF style contradicts pinned metadata: {face['filename']}")
    if "fvar" in font:
        require("[" in face["filename"], f"Upstream variable TTF contradicts static metadata: {face['filename']}")
        axes = {axis.axisTag: axis for axis in font["fvar"].axes}
        require("wght" in axes and axes["wght"].minValue <= 400 and axes["wght"].maxValue >= 700,
                f"Upstream TTF cannot provide real 400/700: {face['filename']}")
    else:
        require("[" not in face["filename"] and font["OS/2"].usWeightClass == face["weight"],
                f"Upstream TTF weight contradicts pinned metadata: {face['filename']}")


def validate_core_styles(faces, label):
    for style in ("normal", "italic"):
        for weight in (400, 700):
            matches = [face for face in faces if face["style"] == style and
                       int(face["weight"].split()[0]) <= weight <= int(face["weight"].split()[-1])]
            require(len(matches) == 1, f"Missing/ambiguous real {style} {weight}: {label}")


def name_values(family, style, weight):
    suffix = {"400": "Regular", "500": "Medium", "600": "SemiBold", "700": "Bold"}.get(weight, "Regular")
    if style == "italic":
        suffix = "Italic" if suffix == "Regular" else suffix + " Italic"
    ps = family.replace(" ", "")
    ps_suffix = suffix.replace(" ", "")
    return {1: family, 2: suffix, 3: f"{ps}-{ps_suffix};DrebLatin-v1", 4: f"{family} {suffix}",
            6: f"{ps}-{ps_suffix}", 16: family, 17: suffix, 18: f"{family} {suffix}",
            20: f"{ps}-{ps_suffix}", 21: family, 22: suffix, 25: ps}


def rename(font, family, style, weight):
    names = font["name"]
    replacements = name_values(family, style, weight)
    # No custom upstream names survive in variable axes/STAT/instance identifiers.
    custom_ids = {record.nameID for record in names.names if record.nameID >= 256}
    for name_id in custom_ids:
        replacements[name_id] = f"{family} Attribute {name_id}"
    if "fvar" in font:
        for axis in font["fvar"].axes:
            replacements[axis.axisNameID] = f"{family} Weight"
        next_id = max({255} | {record.nameID for record in names.names}) + 1
        for index, instance in enumerate(font["fvar"].instances, 1):
            # Some upstream instances share ID 2 (Regular); give every instance
            # its own ID so it cannot overwrite the required base identity.
            instance.subfamilyNameID = next_id
            replacements[next_id] = f"{family} Instance {index:02}"
            next_id += 1
            instance.postscriptNameID = next_id
            replacements[next_id] = family.replace(" ", "") + f"-Instance{index:02}"
            next_id += 1
    names.names = [record for record in names.names if record.nameID not in replacements]
    for name_id, text in sorted(replacements.items()):
        # One Unicode and one Windows Unicode English record, no stale localized identities.
        names.setName(text, name_id, 0, 4, 0)
        names.setName(text, name_id, 3, 1, 0x409)
    # These sources are TrueType outlines, not CFF with another family-name store.
    require("CFF " not in font and "CFF2" not in font, "Unexpected CFF name store")
    return replacements


def validate_names(font, family, style, weight):
    expected = name_values(family, style, weight)
    for name_id, value in expected.items():
        records = [record.toUnicode() for record in font["name"].names if record.nameID == name_id]
        require(records and set(records) == {value}, f"Incorrect neutral name ID {name_id}: {family}")
    for record in font["name"].names:
        if record.nameID >= 256:
            require(record.toUnicode().startswith((family, family.replace(" ", ""))),
                    f"Non-neutral variation identifier: {family}, {record.nameID}")
    if "fvar" in font:
        for instance in font["fvar"].instances:
            require(font["name"].getDebugName(instance.subfamilyNameID).startswith(family),
                    "Unrenamed variable instance")
            if instance.postscriptNameID != 0xFFFF:
                require(font["name"].getDebugName(instance.postscriptNameID).startswith(family.replace(" ", "")),
                        "Unrenamed variable PostScript instance")


def outline_signature(font, glyph_name):
    glyph = font["glyf"][glyph_name]
    coordinates, endpoints, flags = glyph.getCoordinates(font["glyf"])
    # WOFF2 may normalize encoding flags, but on/off-curve points, coordinates,
    # contour endpoints and hint bytecode must remain identical.
    hints = bytes(glyph.program.getBytecode()) if hasattr(glyph, "program") else b""
    return (tuple(coordinates), tuple(endpoints), tuple(flag & 1 for flag in flags), hints)


def transform(data, family, face):
    font = TTFont(io.BytesIO(data), recalcTimestamp=False)
    validate_source_face(font, face)
    source_points = set(font.getBestCmap())
    notices = {(record.nameID, record.toUnicode()) for record in font["name"].names
               if record.nameID in NOTICE_IDS}
    axis_details = []
    weight = str(face["weight"])
    if "fvar" in font:
        limits = {}
        for axis in font["fvar"].axes:
            upstream = [axis.minValue, axis.defaultValue, axis.maxValue]
            if axis.axisTag == "wght":
                require(axis.minValue <= 400 and axis.maxValue >= 700, f"No upstream 400–700: {family}")
                limits[axis.axisTag] = (400, max(400, min(axis.defaultValue, 700)), 700)
                weight = "400 700"
            else:
                limits[axis.axisTag] = axis.defaultValue
            retained = limits[axis.axisTag]
            axis_details.append({"tag": axis.axisTag, "upstreamMinDefaultMax": upstream,
                                 "retained": list(retained) if isinstance(retained, tuple) else retained})
        font = instantiateVariableFont(font, limits, inplace=True, optimize=True)
        # fontTools 4.63.0 drops empty gvar entries while instancing, but its
        # subsetter expects an entry for every surviving glyph (e.g. filledbox
        # in Roboto). Restore empty entries; this changes no outline/delta.
        if "gvar" in font:
            for glyph in font.getGlyphOrder():
                if glyph not in font["gvar"].variations:
                    font["gvar"].variations[glyph] = []
    # Materialize the evaluated upstream instance in TrueType's integer
    # coordinate encoding before comparing outlines (clamping a default below
    # 400 can evaluate fractional coordinates, e.g. Montserrat).
    normalized = io.BytesIO()
    font.save(normalized, reorderTables=True)
    font = TTFont(io.BytesIO(normalized.getvalue()), recalcTimestamp=False)
    # Keep all layout features and unchanged surviving outlines/hints. Instancing
    # evaluates upstream variations; it does not redesign the source letterforms.
    outlines = {glyph: outline_signature(font, glyph) for glyph in font.getGlyphOrder()}
    options = subset.Options()
    options.notdef_outline = True
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.name_legacy = True
    options.glyph_names = True
    options.recalc_timestamp = False
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=sorted(REQUESTED))
    subsetter.subset(font)
    rename(font, family, face["style"], weight)
    font.recalcTimestamp = False
    font.flavor = "woff2"
    output = io.BytesIO()
    retained_order = font.getGlyphOrder()[:]
    font.save(output, reorderTables=True)
    result = output.getvalue()
    verified = TTFont(io.BytesIO(result), recalcTimestamp=False)
    points = set(verified.getBestCmap())
    require(points == source_points & REQUESTED, f"Subset coverage mismatch: {family}")
    require(notices <= {(record.nameID, record.toUnicode()) for record in verified["name"].names},
            f"Lost copyright/trademark/license notice: {family}")
    validate_names(verified, family, face["style"], weight)
    require(len(verified.getGlyphOrder()) == len(retained_order), "Glyph count changed during WOFF2 encoding")
    # post format 3 sources regenerate synthetic glyph names on reload, so use
    # stable glyph indices rather than requiring those synthetic names to match.
    for glyph, original_glyph in zip(verified.getGlyphOrder(), retained_order):
        require(outline_signature(verified, glyph) == outlines[original_glyph],
                f"Surviving outline/hint changed: {family}, {original_glyph}")
    if "fvar" in verified:
        axes = verified["fvar"].axes
        require(len(axes) == 1 and axes[0].axisTag == "wght" and
                axes[0].minValue == 400 and axes[0].maxValue == 700,
                f"Unexpected retained axes: {family}")
        require(weight == f"{axes[0].minValue:g} {axes[0].maxValue:g}", "Weight declaration mismatch")
    else:
        require(" " not in weight and int(weight) == verified["OS/2"].usWeightClass,
                f"Static weight mismatch: {family}")
    require(bool(verified["OS/2"].fsSelection & 1) == (face["style"] == "italic"),
            f"Style mismatch: {family}")
    return result, weight, points, axis_details, verified["maxp"].numGlyphs


def stylesheet(catalog):
    lines = ["/* Generated by scripts/build-font-catalog.py; do not edit. */", ""]
    for entry in catalog:
        for face in entry["faces"]:
            lines.extend(["@font-face {", f"  font-family: '{entry['family']}';",
                          f"  src: url('../assets/fonts/expanded/{face['file']}') format('woff2');",
                          f"  font-style: {face['style']};", f"  font-weight: {face['weight']};",
                          "  font-display: swap;", "}", ""])
        lines.extend([f"[data-font='{entry['id']}'] {{",
                      f"  --mono-font: '{entry['family']}', 'IBM Plex Mono', 'Courier New', monospace;",
                      "}", ""])
    return ("\n".join(lines).rstrip() + "\n").encode()


def selection_snapshot(path):
    require(path is not None, "Acquisition requires --selection-snapshot pointing to the approved saved response")
    data = path.read_bytes()
    require(sha(data) == POPULARITY_SHA256, "Not the original approved 2026-10-02 popularity snapshot")
    metadata = json.loads(data)
    indexed = {entry["family"]: entry for entry in metadata["familyMetadataList"]}
    selected = []
    for family in families():
        key = family["label"]
        require(key in indexed, f"Approved family missing from popularity metadata: {key}")
        if key in REPLACEMENT_RANKS:
            require(indexed[key]["popularity"] == REPLACEMENT_RANKS[key], f"Replacement popularity mismatch: {key}")
        selected.append({"id": family["id"], **indexed[key]})
    return {"selectionDate": SELECTION_DATE, "sourceUrl": POPULARITY_URL,
            "responseSha256": sha(data), "note": "Approved 15 sans + 15 serif selection in settled order; popularity is upstream metadata, not a runtime fetch or a claim of strict rank sorting.",
            "selectedFamilyMetadata": selected}


def provenance(catalog, details, source_lock, selection):
    total = sum(face["bytes"] for entry in catalog for face in entry["faces"])
    lines = ["# Expanded Latin font catalog — PR540", "",
             "## Source and approved selection", "",
             f"All fonts, metadata and license/trademark files come from google/fonts commit `{COMMIT}`.",
             f"Approved selection: 15 sans-serif followed by 15 serif families, in catalog order, based on Google Fonts metadata on {SELECTION_DATE}.",
             f"Popularity source: {POPULARITY_URL}; `selection-metadata.json` preserves the selected upstream records and the full response SHA-256 `{selection['responseSha256']}`.",
             "This is a build-time snapshot, not a runtime fetch; the settled order is not asserted to be a strict global popularity ranking.",
             "Original family labels in this source manifest identify upstream designs and imply no endorsement. RFN-restricted derivatives use their neutral family as the primary Dashboard menu/trigger name, with the original family only in a clearly secondary Based on source description. Typeahead may search that source attribution without changing the derivative identity.", "",
             "## Reproduction and verification", "", "```sh",
             "python3 -m venv /tmp/dreb-fonts-venv",
             "/tmp/dreb-fonts-venv/bin/pip install fonttools==4.63.0 brotli==1.2.0",
             "/tmp/dreb-fonts-venv/bin/python packages/dashboard/scripts/build-font-catalog.py",
             "/tmp/dreb-fonts-venv/bin/python packages/dashboard/scripts/build-font-catalog.py --verify",
             "```", "",
             "Python 3.14 is required. Acquisition uses the original saved `/tmp/pr540-font-work/popularity.json` response via `--selection-snapshot`, with its approved SHA-256/date, never a live ordering fetch. Initial `--bootstrap` is allowed only without a source lock. This revision used `--refresh-acquisition --backup-dir <new-directory-outside-repo>`: previous assets, CSS and script are backed up before refresh; shared source records remain hash-checked, new sources are fetched from the same pinned commit (any pre-existing unpinned cache bytes must match), and obsolete binaries/notices/metadata/source entries are removed only after successful acquisition. Subsequent builds verify every source SHA-256/size/URL against `sources.lock.json`, including cached TTFs, metadata and notices, and compare all generated outputs before writing. Rebuild offline with `--offline --cache-dir /tmp/pr540-font-work/sources`. `--verify` independently checks bundled binaries, neutral names, all four real core styles, retained axes, exact coverage, local source metadata/notices, selection snapshot, exact file/source inventory and generated CSS offline. No Python dependency at browser/server runtime.", "",
             "## Derivative processing and naming", "",
             "Subset requested codepoints: `U+0000-024F,U+0300-036F,U+2000-27BF` (Basic Latin, Latin-1, Latin Extended A/B, common combining marks, punctuation, currency, mathematical operators, arrows, technical/enclosed symbols, geometric shapes, status symbols and dingbats). Only actually present codepoints survive. No giant CJK/Devanagari subsets are retained.",
             "Every selected family must supply four real upstream core styles: normal 400, normal 700, italic 400 and italic 700. Eligibility is enforced against pinned METADATA.pb selection and actual TTF styles/weights/axes, and again against generated WOFF2s offline. No upright-only exemption or synthetic important style is permitted. Dedicated non-Latin variants remain excluded.",
             "Rejected Oswald and Roboto Slab lack italic faces; Instrument Serif and DM Serif Display lack bold faces. The settled roster replaces them with Rubik (snapshot popularity rank 29), Crimson Text (133), Arvo (143) and Bodoni Moda (156). The approved 15+15 order is preserved, rather than re-sorting against changing live metadata.",
             "All layout features, surviving glyph outlines (including .notdef) and hints are retained; variable instancing evaluates the upstream outlines at upstream default non-weight axes. No letterforms were redesigned. Both variable normal and variable italic retain exactly wght 400–700 (default clamped into that range); all other axes freeze at actual upstream TTF defaults, not registry defaults. Static normal includes 400, 700 and any available 500/600; static italic includes only 400 and 700. Browsers can fetch one normal variable face for regular 400 where available; extra static and italic faces remain lazy @font-face resources.",
             "The evaluated upstream instance is materialized in TrueType integer coordinates before subsetting. Every surviving glyph's coordinates, contour endpoints, on/off-curve flags and hint bytecode are checked unchanged after WOFF2 encoding. For fontTools 4.63.0's instancer/subsetter mismatch, missing empty gvar entries are restored before subsetting (no outline or delta changes). Source files with post format 3 use glyph indices for this comparison because synthetic glyph names can change on reload.",
             "All derivative name IDs 1/2/3/4/6/16/17/25 (also 18/20/21/22), custom variation/STAT names, instance names and instance PostScript names are rewritten to neutral Dreb Sans/Serif 01–15 families (PT Serif instead uses Dreb Text 07 to avoid the reserved word Serif) and matching neutral PostScript identifiers. Localized upstream identities are removed. Copyright, trademark and license notice name IDs 0/7/13/14 are retained unchanged. Source timestamps are preserved with recalculation disabled. WOFF2 encoding uses the pinned Brotli version.",
             "`catalog.json` coverage is the exact verified intersection of cmap codepoints across a family's faces; per-face actual ranges below preserve any differences. Coverage ranges do not promise every requested codepoint. Missing codepoints resolve through `'IBM Plex Mono', 'Courier New', monospace` and then browser fallback; no glyphs or faces are fabricated.", "",
             "## Licenses and caveats", "",
             "All 30 families use SIL OFL 1.1, checked from their actual pinned upstream OFL.txt contents; each verbatim OFL is bundled in `licenses/<id>/OFL.txt`. These modified subsets use neutral names even where an upstream Reserved Font Name exists. Notices retain original attribution, as required; RFNs and Google Sans trademarks are not used as derivative font identifiers. OFL derivatives remain OFL and may not be sold by themselves.",
             "This provenance identifies the modified subset/instancing/renaming/container conversion. Google Sans includes verbatim TRADEMARKS.md in addition to OFL.txt; its original label is attribution only and conveys no Google endorsement or trademark rights.", "",
             "## Binary payload", "",
             f"Existing bundled binaries (untouched): **{EXISTING_BYTES:,} bytes**.",
             f"Regular-400 browser faces: **{sum(entry['regular400Bytes'] for entry in catalog):,} bytes** across 30 families (includes the complete 400–700 normal variable resource where applicable).",
             f"Source-complete bundled additions (all required styles plus available static normal 500/600): **{total:,} bytes**, {sum(len(entry['faces']) for entry in catalog)} WOFF2 faces across {len(catalog)} families.",
             f"Combined font binary payload: **{EXISTING_BYTES + total:,} bytes**. Metadata, source lock, notices, provenance and CSS are additional non-font bytes; source TTFs stay in a temporary development cache and are not bundled.", ""]
    for entry in catalog:
        family_details = details[entry["id"]]
        lines.extend([f"## {entry['label']} → {entry['family']}", "",
                      f"ID: `{entry['id']}`; group: {entry['group']}; bytes: {sum(face['bytes'] for face in entry['faces']):,}.",
                      f"Upstream metadata: [{family_details['metadataPath']}]({encoded_url(family_details['metadataPath'])}) (bundled verbatim as `metadata/{entry['id']}.pb`).",
                      "License/notice files: " + ", ".join(f"`{file}`" for file in entry["licenseFiles"]) + "."])
        lines.append(f"Regular-400 face payload: **{entry['regular400Bytes']:,} bytes**; all four real core styles verified.")
        lines.append("")
        for face, detail in zip(entry["faces"], family_details["faces"]):
            lines.extend([f"### `{face['file']}`", "",
                          f"Style: {face['style']}; weight: `{face['weight']}`; bytes: {face['bytes']:,}; glyphs: {detail['glyphs']}; cmap codepoints: {len(detail['points'])}.",
                          f"Source: {face['sourceUrl']}",
                          f"Source SHA-256: `{face['sourceSha256']}`; source bytes: {detail['sourceBytes']:,}.",
                          f"WOFF2 SHA-256: `{face['sha256']}`.",
                          "Axes (upstream min/default/max → retained): " + (json.dumps(detail["axes"]) if detail["axes"] else "static upstream face") + ".",
                          "Actual verified cmap coverage: `" + ",".join(ranges(detail["points"])) + "`.",
                          "Missing requested status glyphs (browser fallback): " + (", ".join(f"U+{point:04X}" for point in [0x25CF, 0x25C6, 0x25CB, 0x2715, 0x21BB] if point not in detail["points"]) or "none") + ".", ""])
    lines.extend(["## Pinned non-binary sources", "",
                  "All acquired source records (including TTFs) are hash/size/URL pinned in `sources.lock.json`. Verbatim bundled metadata and notices:", ""])
    for path, record in source_lock["sources"].items():
        if not path.endswith(".ttf"):
            lines.append(f"- [{path}]({record['url']}): {record['bytes']} bytes; SHA-256 `{record['sha256']}`.")
    return ("\n".join(lines) + "\n").encode()


def build(bootstrap, cache, refresh=False, snapshot=None, offline=False):
    sources = Sources(bootstrap, cache, refresh, offline)
    if bootstrap or refresh:
        selection = selection_snapshot(snapshot)
    else:
        selection = json.loads((ASSETS / "selection-metadata.json").read_text())
    require(selection["selectionDate"] == SELECTION_DATE and
            [item["id"] for item in selection["selectedFamilyMetadata"]] == [item["id"] for item in families()],
            "Selection snapshot mismatch")
    outputs = sources.outputs
    catalog = []
    details = {}
    for family in families():
        metadata_path = family["folder"] + "/METADATA.pb"
        metadata, _ = sources.get(metadata_path, f"metadata/{family['id']}.pb")
        selected = selected_faces(parse_faces(metadata.decode()))
        licenses = ["OFL.txt"]
        if family["label"] == "Google Sans":
            licenses.append("TRADEMARKS.md")
        license_files = []
        for filename in licenses:
            local = f"licenses/{family['id']}/{filename}"
            notice, _ = sources.get(f"{family['folder']}/{filename}", local)
            if filename == "OFL.txt":
                require(b"SIL OPEN FONT LICENSE Version 1.1" in notice and
                        b"PREAMBLE" in notice, f"Not actual upstream OFL 1.1: {family['label']}")
            license_files.append(local)
        entry = {key: family[key] for key in ("id", "label", "group", "family")}
        entry["faces"] = []
        entry["licenseFiles"] = license_files
        face_details = []
        for face in selected:
            data, record = sources.get(f"{family['folder']}/{face['filename']}")
            binary, weight, points, axes, glyphs = transform(data, family["family"], face)
            suffix = f"-{weight}" if "[" not in face["filename"] else ""
            filename = f"{family['stem']}-{face['style']}{suffix}.woff2"
            outputs[ASSETS / filename] = binary
            entry["faces"].append({"file": filename, "style": face["style"], "weight": weight,
                                   "sha256": sha(binary), "bytes": len(binary),
                                   "sourceUrl": record["url"], "sourceSha256": record["sha256"],
                                   "sourceBytes": record["bytes"], "axes": axes,
                                   "coverage": ranges(points), "glyphs": glyphs})
            face_details.append({"points": points, "axes": axes, "glyphs": glyphs,
                                 "sourceBytes": record["bytes"]})
        validate_core_styles(entry["faces"], entry["label"])
        entry["regular400Bytes"] = sum(face["bytes"] for face in entry["faces"]
                                       if face["style"] == "normal" and face["weight"].split()[0] == "400")
        entry["totalBytes"] = sum(face["bytes"] for face in entry["faces"])
        entry["coverage"] = ranges(set.intersection(*(detail["points"] for detail in face_details)))
        catalog.append(entry)
        details[family["id"]] = {"metadataPath": metadata_path, "faces": face_details}
        print(f"{family['label']}: {len(entry['faces'])} faces, {sum(face['bytes'] for face in entry['faces']):,} bytes", flush=True)
    lock = sources.lock()
    selection_bytes = json_bytes(selection)
    selection_hash = sha(selection_bytes)
    if not bootstrap and not refresh:
        previous_lock = json.loads((ASSETS / "sources.lock.json").read_text())
        require(selection_hash == previous_lock["selectionSha256"], "Selection snapshot hash mismatch")
    lock["selectionSha256"] = selection_hash
    outputs[ASSETS / "sources.lock.json"] = json_bytes(lock)
    outputs[ASSETS / "selection-metadata.json"] = selection_bytes
    outputs[ASSETS / "catalog.json"] = json_bytes(catalog)
    outputs[ASSETS / "PROVENANCE.md"] = provenance(catalog, details, lock, selection)
    outputs[CSS] = stylesheet(catalog)
    if not bootstrap and not refresh:
        previous = json.loads((ASSETS / "catalog.json").read_text())
        require(catalog == previous, "Rebuilt catalog/hash differs; no files written")
        for path, data in outputs.items():
            require(path.read_bytes() == data, f"Non-deterministic rebuild: {path}")
    if refresh:
        # Acquisition has completed and all outputs are validated in memory.
        # Obsolete files are removed only now, after the required external backup.
        for path in ASSETS.rglob("*"):
            if path.is_file() and path not in outputs:
                path.unlink()
        for path in sorted(ASSETS.rglob("*"), reverse=True):
            if path.is_dir() and not any(path.iterdir()):
                path.rmdir()
    for path, data in outputs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    verify()


def verify():
    catalog = json.loads((ASSETS / "catalog.json").read_text())
    lock = json.loads((ASSETS / "sources.lock.json").read_text())
    require(lock["commit"] == COMMIT, "Source revision mismatch")
    require(sha((ASSETS / "selection-metadata.json").read_bytes()) == lock["selectionSha256"],
            "Selection snapshot hash mismatch")
    selection = json.loads((ASSETS / "selection-metadata.json").read_text())
    require(selection["selectionDate"] == SELECTION_DATE and selection["responseSha256"] == POPULARITY_SHA256
            and selection["sourceUrl"] == POPULARITY_URL, "Wrong approved popularity snapshot")
    require([(item["id"], item["family"]) for item in selection["selectedFamilyMetadata"]] ==
            [(item["id"], item["label"]) for item in families()], "Selection order/identity mismatch")
    for item in selection["selectedFamilyMetadata"]:
        if item["family"] in REPLACEMENT_RANKS:
            require(item["popularity"] == REPLACEMENT_RANKS[item["family"]], "Wrong replacement rank")
    require(len(catalog) == 30, "Missing approved families")
    used_sources = set()
    expected_paths = {"catalog.json", "sources.lock.json", "selection-metadata.json", "PROVENANCE.md"}
    for entry, family in zip(catalog, families()):
        for key in ("id", "label", "group", "family"):
            require(entry[key] == family[key], f"Approved catalog order/identity mismatch: {key}")
        metadata_file = f"metadata/{entry['id']}.pb"
        expected_paths.add(metadata_file)
        metadata = (ASSETS / metadata_file).read_bytes()
        metadata_path = family["folder"] + "/METADATA.pb"
        used_sources.add(metadata_path)
        require(sha(metadata) == lock["sources"][metadata_path]["sha256"] and
                len(metadata) == lock["sources"][metadata_path]["bytes"], "Metadata hash/size mismatch")
        selected = selected_faces(parse_faces(metadata.decode()))
        require(len(selected) == len(entry["faces"]), f"Missing/extra faces: {entry['label']}")
        validate_core_styles(entry["faces"], entry["label"])
        require(entry["totalBytes"] == sum(face["bytes"] for face in entry["faces"]) and
                entry["regular400Bytes"] == sum(face["bytes"] for face in entry["faces"]
                                                if face["style"] == "normal" and face["weight"].split()[0] == "400"),
                "Incorrect payload totals")
        required_notices = ["OFL.txt"]
        if family["label"] == "Google Sans":
            required_notices.append("TRADEMARKS.md")
        require(entry["licenseFiles"] == [f"licenses/{entry['id']}/{name}" for name in required_notices],
                "Missing/misclassified license or trademark notice")
        all_points = []
        for face, upstream in zip(entry["faces"], selected):
            expected_paths.add(face["file"])
            require(face["file"].startswith(family["stem"] + "-"), "Non-neutral filename")
            data = (ASSETS / face["file"]).read_bytes()
            require(sha(data) == face["sha256"] and len(data) == face["bytes"], f"Binary hash/size mismatch: {face['file']}")
            require(face["style"] == upstream["style"], "Nonexistent source style")
            source_path = family["folder"] + "/" + upstream["filename"]
            used_sources.add(source_path)
            source = lock["sources"][source_path]
            require(face["sourceSha256"] == source["sha256"] and face["sourceUrl"] == source["url"]
                    and face["sourceBytes"] == source["bytes"], "Incorrect source reference")
            font = TTFont(io.BytesIO(data), recalcTimestamp=False)
            require(font.flavor == "woff2", "Wrong font container")
            validate_names(font, entry["family"], face["style"], face["weight"])
            points = set(font.getBestCmap())
            require(points <= REQUESTED, "Non-Latin-focused codepoints leaked")
            require(face["coverage"] == ranges(points) and face["glyphs"] == font["maxp"].numGlyphs,
                    "False per-face coverage/glyph count")
            all_points.append(points)
            if "fvar" in font:
                axes = font["fvar"].axes
                require("[" in upstream["filename"] and len(axes) == 1 and axes[0].axisTag == "wght",
                        "Unexpected variable axes")
                require(axes[0].minValue == 400 and axes[0].maxValue == 700 and
                        face["weight"] == "400 700", "False weight range")
                source_axes = {axis["tag"]: axis for axis in face["axes"]}
                require("wght" in source_axes, "Missing source weight axis provenance")
                for tag, axis in source_axes.items():
                    low, default, high = axis["upstreamMinDefaultMax"]
                    require(low <= default <= high, "Invalid upstream axis range")
                    require(axis["retained"] == ([400, max(400, min(default, 700)), 700]
                                                if tag == "wght" else default), "Incorrect retained source axes")
                    if tag == "wght":
                        require(low <= 400 and high >= 700 and axes[0].defaultValue == max(400, min(default, 700)),
                                "Upstream weight axis cannot provide real core styles")
            else:
                require("[" not in upstream["filename"] and not face["axes"] and
                        face["weight"] == str(upstream["weight"]) == str(font["OS/2"].usWeightClass),
                        "False static weight")
            require(bool(font["OS/2"].fsSelection & 1) == (face["style"] == "italic"), "False italic declaration")
        require(expand_ranges(entry["coverage"]) == set.intersection(*all_points), "False coverage ranges")
        require(entry["coverage"] == ranges(set.intersection(*all_points)), "Unsorted/noncompact coverage ranges")
        for filename in entry["licenseFiles"]:
            expected_paths.add(filename)
            source_path = family["folder"] + "/" + Path(filename).name
            used_sources.add(source_path)
            source = lock["sources"][source_path]
            data = (ASSETS / filename).read_bytes()
            require(sha(data) == source["sha256"] and len(data) == source["bytes"], "License/notice hash mismatch")
            if filename.endswith("OFL.txt"):
                require(b"SIL OPEN FONT LICENSE Version 1.1" in data and b"PREAMBLE" in data,
                        "Not actual upstream OFL 1.1")
    require(used_sources == set(lock["sources"]), "Unused/missing source entries")
    for path, record in lock["sources"].items():
        require(record["url"] == encoded_url(path), f"Unpinned source URL: {path}")
    actual_paths = {path.relative_to(ASSETS).as_posix() for path in ASSETS.rglob("*") if path.is_file()}
    require(actual_paths == expected_paths, f"Unexpected/missing generated assets: {actual_paths ^ expected_paths}")
    require(CSS.read_bytes() == stylesheet(catalog), "Generated CSS mismatch")
    total = sum(face["bytes"] for entry in catalog for face in entry["faces"])
    regular_total = sum(entry["regular400Bytes"] for entry in catalog)
    print(f"Verified {len(catalog)} families, {sum(len(entry['faces']) for entry in catalog)} faces; "
          f"regular-400 faces {regular_total:,} B; source-complete additions {total:,} B; "
          f"existing + additions {EXISTING_BYTES + total:,} B")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bootstrap", action="store_true")
    parser.add_argument("--refresh-acquisition", action="store_true")
    parser.add_argument("--backup-dir", type=Path)
    parser.add_argument("--selection-snapshot", type=Path)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--offline", action="store_true", help="Rebuild using only hash-pinned cache sources")
    parser.add_argument("--cache-dir", type=Path)
    args = parser.parse_args()
    require(sum((args.bootstrap, args.refresh_acquisition, args.verify)) <= 1,
            "--bootstrap, --refresh-acquisition and --verify are mutually exclusive")
    require(not args.offline or (args.cache_dir and not args.bootstrap and not args.refresh_acquisition),
            "--offline rebuild requires --cache-dir and an existing lock")
    require(version("fonttools") == "4.63.0" and version("brotli") == "1.2.0", "Use pinned fonttools==4.63.0 and brotli==1.2.0")
    require(sys.version_info[:2] == (3, 14), "Use the pinned Python 3.14 build environment")
    logging.basicConfig(level=logging.ERROR)
    if args.bootstrap or args.refresh_acquisition:
        selection_snapshot(args.selection_snapshot)  # Validate before any backup or acquisition.
    if args.refresh_acquisition:
        require((ASSETS / "sources.lock.json").exists(), "Refresh requires an existing lock")
        require(args.backup_dir is not None, "Refresh requires --backup-dir outside the repository")
        backup = args.backup_dir.resolve()
        require(not backup.is_relative_to(ROOT.parents[1]) and not backup.exists(),
                "Backup must be a new directory outside the repository")
        backup.mkdir(parents=True)
        shutil.copytree(ASSETS, backup / "expanded")
        shutil.copy2(CSS, backup / CSS.name)
        shutil.copy2(Path(__file__), backup / Path(__file__).name)
        print(f"Acquisition refresh backed up to {backup}", flush=True)
    if args.verify:
        verify()
    elif args.cache_dir:
        args.cache_dir.mkdir(parents=True, exist_ok=True)
        build(args.bootstrap, args.cache_dir, args.refresh_acquisition, args.selection_snapshot, args.offline)
    else:
        with tempfile.TemporaryDirectory(prefix="dreb-fonts-") as directory:
            build(args.bootstrap, Path(directory), args.refresh_acquisition, args.selection_snapshot)


if __name__ == "__main__":
    main()
