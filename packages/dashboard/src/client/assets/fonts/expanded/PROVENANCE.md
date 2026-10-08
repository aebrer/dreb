# Expanded Latin font catalog — PR540

## Source and approved selection

All fonts, metadata and license/trademark files come from google/fonts commit `9710da1eacb3be272583c3224dcb70f9da6eadbb`.
Approved selection: 15 sans-serif followed by 15 serif families, in catalog order, based on Google Fonts metadata on 2026-10-02.
Popularity source: https://fonts.google.com/metadata/fonts; `selection-metadata.json` preserves the selected upstream records and the full response SHA-256 `0c4c0412a092525c7e82bcef498c74993b4ec983b915cd321aa3545f09c60b00`.
This is a build-time snapshot, not a runtime fetch; the settled order is not asserted to be a strict global popularity ranking.
Original family labels in this source manifest identify upstream designs and imply no endorsement. RFN-restricted derivatives use their neutral family as the primary Dashboard menu/trigger name, with the original family only in a clearly secondary Based on source description. Typeahead may search that source attribution without changing the derivative identity.

## Reproduction and verification

```sh
python3 -m venv /tmp/dreb-fonts-venv
/tmp/dreb-fonts-venv/bin/pip install fonttools==4.63.0 brotli==1.2.0
/tmp/dreb-fonts-venv/bin/python packages/dashboard/scripts/build-font-catalog.py
/tmp/dreb-fonts-venv/bin/python packages/dashboard/scripts/build-font-catalog.py --verify
```

Python 3.14 is required. Acquisition uses the original saved `/tmp/pr540-font-work/popularity.json` response via `--selection-snapshot`, with its approved SHA-256/date, never a live ordering fetch. Initial `--bootstrap` is allowed only without a source lock. This revision used `--refresh-acquisition --backup-dir <new-directory-outside-repo>`: previous assets, CSS and script are backed up before refresh; shared source records remain hash-checked, new sources are fetched from the same pinned commit (any pre-existing unpinned cache bytes must match), and obsolete binaries/notices/metadata/source entries are removed only after successful acquisition. Subsequent builds verify every source SHA-256/size/URL against `sources.lock.json`, including cached TTFs, metadata and notices, and compare all generated outputs before writing. Rebuild offline with `--offline --cache-dir /tmp/pr540-font-work/sources`. `--verify` independently checks bundled binaries, neutral names, all four real core styles, retained axes, exact coverage, local source metadata/notices, selection snapshot, exact file/source inventory and generated CSS offline. No Python dependency at browser/server runtime.

## Derivative processing and naming

Subset requested codepoints: `U+0000-024F,U+0300-036F,U+2000-27BF` (Basic Latin, Latin-1, Latin Extended A/B, common combining marks, punctuation, currency, mathematical operators, arrows, technical/enclosed symbols, geometric shapes, status symbols and dingbats). Only actually present codepoints survive. No giant CJK/Devanagari subsets are retained.
Every selected family must supply four real upstream core styles: normal 400, normal 700, italic 400 and italic 700. Eligibility is enforced against pinned METADATA.pb selection and actual TTF styles/weights/axes, and again against generated WOFF2s offline. No upright-only exemption or synthetic important style is permitted. Dedicated non-Latin variants remain excluded.
Rejected Oswald and Roboto Slab lack italic faces; Instrument Serif and DM Serif Display lack bold faces. The settled roster replaces them with Rubik (snapshot popularity rank 29), Crimson Text (133), Arvo (143) and Bodoni Moda (156). The approved 15+15 order is preserved, rather than re-sorting against changing live metadata.
All layout features, surviving glyph outlines (including .notdef) and hints are retained; variable instancing evaluates the upstream outlines at upstream default non-weight axes. No letterforms were redesigned. Both variable normal and variable italic retain exactly wght 400–700 (default clamped into that range); all other axes freeze at actual upstream TTF defaults, not registry defaults. Static normal includes 400, 700 and any available 500/600; static italic includes only 400 and 700. Browsers can fetch one normal variable face for regular 400 where available; extra static and italic faces remain lazy @font-face resources.
The evaluated upstream instance is materialized in TrueType integer coordinates before subsetting. Every surviving glyph's coordinates, contour endpoints, on/off-curve flags and hint bytecode are checked unchanged after WOFF2 encoding. For fontTools 4.63.0's instancer/subsetter mismatch, missing empty gvar entries are restored before subsetting (no outline or delta changes). Source files with post format 3 use glyph indices for this comparison because synthetic glyph names can change on reload.
All derivative name IDs 1/2/3/4/6/16/17/25 (also 18/20/21/22), custom variation/STAT names, instance names and instance PostScript names are rewritten to neutral Dreb Sans/Serif 01–15 families (PT Serif instead uses Dreb Text 07 to avoid the reserved word Serif) and matching neutral PostScript identifiers. Localized upstream identities are removed. Copyright, trademark and license notice name IDs 0/7/13/14 are retained unchanged. Source timestamps are preserved with recalculation disabled. WOFF2 encoding uses the pinned Brotli version.
`catalog.json` coverage is the exact verified intersection of cmap codepoints across a family's faces; per-face actual ranges below preserve any differences. Coverage ranges do not promise every requested codepoint. Missing codepoints resolve through `'IBM Plex Mono', 'Courier New', monospace` and then browser fallback; no glyphs or faces are fabricated.

## Licenses and caveats

All 30 families use SIL OFL 1.1, checked from their actual pinned upstream OFL.txt contents; each verbatim OFL is bundled in `licenses/<id>/OFL.txt`. These modified subsets use neutral names even where an upstream Reserved Font Name exists. Notices retain original attribution, as required; RFNs and Google Sans trademarks are not used as derivative font identifiers. OFL derivatives remain OFL and may not be sold by themselves.
This provenance identifies the modified subset/instancing/renaming/container conversion. Google Sans includes verbatim TRADEMARKS.md in addition to OFL.txt; its original label is attribution only and conveys no Google endorsement or trademark rights.

## Binary payload

Existing bundled binaries (untouched): **1,395,464 bytes**.
Regular-400 browser faces: **2,350,548 bytes** across 30 families (includes the complete 400–700 normal variable resource where applicable).
Source-complete bundled additions (all required styles plus available static normal 500/600): **5,457,304 bytes**, 75 WOFF2 faces across 30 families.
Combined font binary payload: **6,852,768 bytes**. Metadata, source lock, notices, provenance and CSS are additional non-font bytes; source TTFs stay in a temporary development cache and are not bundled.

## Roboto → Dreb Sans 01

ID: `roboto`; group: Sans-serif; bytes: 127,908.
Upstream metadata: [ofl/roboto/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/roboto/METADATA.pb) (bundled verbatim as `metadata/roboto.pb`).
License/notice files: `licenses/roboto/OFL.txt`.
Regular-400 face payload: **61,432 bytes**; all four real core styles verified.

### `latin-sans-01-normal.woff2`

Style: normal; weight: `400 700`; bytes: 61,432; glyphs: 804; cmap codepoints: 453.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/roboto/Roboto%5Bwdth%2Cwght%5D.ttf
Source SHA-256: `d7598e12c5dbef095ff8272cfc55da0250bd07fbdecbac8a530b9b277872a134`; source bytes: 488,584.
WOFF2 SHA-256: `1f2a77b5ad77b65a8cc2195b656faa9c4c17b56b92f3ca18dca8aa573b70fb16`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [100.0, 400.0, 900.0], "retained": [400, 400, 700]}, {"tag": "wdth", "upstreamMinDefaultMax": [75.0, 100.0, 100.0], "retained": 100.0}].
Actual verified cmap coverage: `U+0000,U+0002,U+000D,U+0020-007E,U+00A0-017F,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01F0,U+01FA-01FF,U+0218-021B,U+0237,U+0300-0301,U+0303,U+0309,U+030F,U+0323,U+2000-200B,U+2010-2011,U+2013-2015,U+2017-201E,U+2020-2022,U+2025-2027,U+2030,U+2032-2033,U+2039-203A,U+203C,U+2044,U+2070,U+2074-208E,U+20A3-20A4,U+20A6-20AC,U+20B1,U+20B9-20BA,U+20BC-20BD,U+20C1,U+2105,U+2113,U+2116,U+2122,U+2126,U+212E,U+215B-215E,U+2202,U+2206,U+220F,U+2211-2212,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25A0,U+25CA-25CB,U+25CF`.
Missing requested status glyphs (browser fallback): U+25C6, U+2715, U+21BB.

### `latin-sans-01-italic.woff2`

Style: italic; weight: `400 700`; bytes: 66,476; glyphs: 804; cmap codepoints: 453.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/roboto/Roboto-Italic%5Bwdth%2Cwght%5D.ttf
Source SHA-256: `9725a847af6b460ffca162ae66d20dad48b01876137947180b42d7dcd7887182`; source bytes: 530,944.
WOFF2 SHA-256: `4bb06f79ab77bb355ee4026bf6eeec255cf0d6da8c5c2c056c76303e8e2ef550`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [100.0, 400.0, 900.0], "retained": [400, 400, 700]}, {"tag": "wdth", "upstreamMinDefaultMax": [75.0, 100.0, 100.0], "retained": 100.0}].
Actual verified cmap coverage: `U+0000,U+0002,U+000D,U+0020-007E,U+00A0-017F,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01F0,U+01FA-01FF,U+0218-021B,U+0237,U+0300-0301,U+0303,U+0309,U+030F,U+0323,U+2000-200B,U+2010-2011,U+2013-2015,U+2017-201E,U+2020-2022,U+2025-2027,U+2030,U+2032-2033,U+2039-203A,U+203C,U+2044,U+2070,U+2074-208E,U+20A3-20A4,U+20A6-20AC,U+20B1,U+20B9-20BA,U+20BC-20BD,U+20C1,U+2105,U+2113,U+2116,U+2122,U+2126,U+212E,U+215B-215E,U+2202,U+2206,U+220F,U+2211-2212,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25A0,U+25CA-25CB,U+25CF`.
Missing requested status glyphs (browser fallback): U+25C6, U+2715, U+21BB.

## Open Sans → Dreb Sans 02

ID: `open-sans`; group: Sans-serif; bytes: 97,432.
Upstream metadata: [ofl/opensans/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/opensans/METADATA.pb) (bundled verbatim as `metadata/open-sans.pb`).
License/notice files: `licenses/open-sans/OFL.txt`.
Regular-400 face payload: **47,980 bytes**; all four real core styles verified.

### `latin-sans-02-normal.woff2`

Style: normal; weight: `400 700`; bytes: 47,980; glyphs: 567; cmap codepoints: 459.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/opensans/OpenSans%5Bwdth%2Cwght%5D.ttf
Source SHA-256: `36643644f318a812aab2d2ed3bb98f8cf0872527f835fe9398d95fe6b9adb878`; source bytes: 532,636.
WOFF2 SHA-256: `8b7884b168aed1434084090d4c9ea1803666456e638ccc89d81170aa64bc5f70`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [300.0, 400.0, 800.0], "retained": [400, 400, 700]}, {"tag": "wdth", "upstreamMinDefaultMax": [75.0, 100.0, 100.0], "retained": 100.0}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-017F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01EA-01ED,U+01F0,U+01FA-01FF,U+0218-021B,U+0237,U+0300-0304,U+0306-030C,U+030F,U+0312,U+0323,U+0326-0328,U+2000-200B,U+2013-2015,U+2017-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+203C,U+2044,U+2070,U+2074-207A,U+207C-208A,U+208C-208E,U+2095-209C,U+20A3-20A4,U+20A7,U+20AA-20AC,U+2105,U+2113,U+2116,U+2120,U+2122,U+2126,U+212E,U+215B-215E,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-sans-02-italic.woff2`

Style: italic; weight: `400 700`; bytes: 49,452; glyphs: 573; cmap codepoints: 459.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/opensans/OpenSans-Italic%5Bwdth%2Cwght%5D.ttf
Source SHA-256: `fe269381e992f32e135801740998544d6235061e37c93ec067ad2be3edd5b17b`; source bytes: 583,992.
WOFF2 SHA-256: `bf2bfa60bf10f98a9a2c500d5f7ed956da91b3a9f1ce006fc7316a1b27afac16`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [300.0, 400.0, 800.0], "retained": [400, 400, 700]}, {"tag": "wdth", "upstreamMinDefaultMax": [75.0, 100.0, 100.0], "retained": 100.0}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-017F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01EA-01ED,U+01F0,U+01FA-01FF,U+0218-021B,U+0237,U+0300-0304,U+0306-030C,U+030F,U+0312,U+0323,U+0326-0328,U+2000-200B,U+2013-2015,U+2017-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+203C,U+2044,U+2070,U+2074-207A,U+207C-208A,U+208C-208E,U+2095-209C,U+20A3-20A4,U+20A7,U+20AA-20AC,U+2105,U+2113,U+2116,U+2120,U+2122,U+2126,U+212E,U+215B-215E,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## Google Sans → Dreb Sans 03

ID: `google-sans`; group: Sans-serif; bytes: 145,436.
Upstream metadata: [ofl/googlesans/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/googlesans/METADATA.pb) (bundled verbatim as `metadata/google-sans.pb`).
License/notice files: `licenses/google-sans/OFL.txt`, `licenses/google-sans/TRADEMARKS.md`.
Regular-400 face payload: **71,168 bytes**; all four real core styles verified.

### `latin-sans-03-normal.woff2`

Style: normal; weight: `400 700`; bytes: 71,168; glyphs: 1150; cmap codepoints: 551.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/googlesans/GoogleSans%5BGRAD%2Copsz%2Cwght%5D.ttf
Source SHA-256: `d0a87d835a944b8b40d0e82a5651bb59ab97b936a2aeed5946eb57e7b2a3a90a`; source bytes: 4,974,940.
WOFF2 SHA-256: `9de97635be534105dfdb71e0ff7aee9d9191ebb6dc9beaf8e9493da726904f7c`.
Axes (upstream min/default/max → retained): [{"tag": "opsz", "upstreamMinDefaultMax": [17.0, 18.0, 18.0], "retained": 18.0}, {"tag": "wght", "upstreamMinDefaultMax": [400.0, 400.0, 700.0], "retained": [400, 400, 700]}, {"tag": "GRAD", "upstreamMinDefaultMax": [-50.0, 0.0, 200.0], "retained": 0.0}].
Actual verified cmap coverage: `U+000D,U+0020-007E,U+00A0-0148,U+014A-017E,U+0181,U+0186,U+018A,U+018F-0190,U+0192,U+0198-0199,U+01A0-01A1,U+01AF-01B0,U+01B3-01B4,U+01CD-01CE,U+01FA-01FF,U+0218-021B,U+0237,U+0300-0304,U+0306-030C,U+0312,U+031B,U+0323-0324,U+0326-0328,U+032E,U+0331,U+034F,U+2000-2011,U+2013-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+202A-202E,U+2030-2033,U+2039-203A,U+203C,U+2042-2044,U+2047-2049,U+204E-204F,U+2051,U+2055,U+2066-2069,U+2070,U+2074-2079,U+2080-2089,U+20A3-20A4,U+20A9-20AE,U+20B1,U+20B4,U+20B8-20BA,U+20BD-20BE,U+20C1,U+2103,U+2109,U+2113-2114,U+2116-2117,U+211E,U+2120,U+2122,U+2126,U+212E,U+2153-2154,U+215B-215E,U+2160-216F,U+2180-2182,U+2190-2193,U+2196-2199,U+21C4,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+22C5,U+22EF,U+2393,U+24BC,U+25A0-25A1,U+25B2-25B3,U+25CA-25CC,U+25CF,U+2713,U+2715,U+275B-275E,U+2780-2788,U+278A-2792`.
Missing requested status glyphs (browser fallback): U+25C6, U+21BB.

### `latin-sans-03-italic.woff2`

Style: italic; weight: `400 700`; bytes: 74,268; glyphs: 1136; cmap codepoints: 550.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/googlesans/GoogleSans-Italic%5BGRAD%2Copsz%2Cwght%5D.ttf
Source SHA-256: `b6662abd2131cad1b248750149a7f2b644f871ebcc9af7fe4cd1135cd290b6d1`; source bytes: 5,079,424.
WOFF2 SHA-256: `1358309c4b6d664f6a6dac18acdda28618ae80d7cd03b0ae7e74166d79227dcb`.
Axes (upstream min/default/max → retained): [{"tag": "opsz", "upstreamMinDefaultMax": [17.0, 18.0, 18.0], "retained": 18.0}, {"tag": "wght", "upstreamMinDefaultMax": [400.0, 400.0, 700.0], "retained": [400, 400, 700]}, {"tag": "GRAD", "upstreamMinDefaultMax": [-50.0, 0.0, 200.0], "retained": 0.0}].
Actual verified cmap coverage: `U+000D,U+0020-007E,U+00A0-0148,U+014A-017E,U+0181,U+0186,U+018A,U+018F-0190,U+0192,U+0198-0199,U+01A0-01A1,U+01AF-01B0,U+01B3-01B4,U+01CD-01CE,U+01FA-01FF,U+0218-021B,U+0237,U+0300-0304,U+0306-030C,U+0312,U+031B,U+0323-0324,U+0326-0328,U+032E,U+0331,U+034F,U+2000-2011,U+2013-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+202A-202E,U+2030-2033,U+2039-203A,U+203C,U+2042-2044,U+2047-2049,U+204E,U+2051,U+2055,U+2066-2069,U+2070,U+2074-2079,U+2080-2089,U+20A3-20A4,U+20A9-20AE,U+20B1,U+20B4,U+20B8-20BA,U+20BD-20BE,U+20C1,U+2103,U+2109,U+2113-2114,U+2116-2117,U+211E,U+2120,U+2122,U+2126,U+212E,U+2153-2154,U+215B-215E,U+2160-216F,U+2180-2182,U+2190-2193,U+2196-2199,U+21C4,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+22C5,U+22EF,U+2393,U+24BC,U+25A0-25A1,U+25B2-25B3,U+25CA-25CC,U+25CF,U+2713,U+2715,U+275B-275E,U+2780-2788,U+278A-2792`.
Missing requested status glyphs (browser fallback): U+25C6, U+21BB.

## Inter → Dreb Sans 04

ID: `inter`; group: Sans-serif; bytes: 218,476.
Upstream metadata: [ofl/inter/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/inter/METADATA.pb) (bundled verbatim as `metadata/inter.pb`).
License/notice files: `licenses/inter/OFL.txt`.
Regular-400 face payload: **105,832 bytes**; all four real core styles verified.

### `latin-sans-04-normal.woff2`

Style: normal; weight: `400 700`; bytes: 105,832; glyphs: 1796; cmap codepoints: 957.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf
Source SHA-256: `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031`; source bytes: 876,576.
WOFF2 SHA-256: `886929eb180d7b287f3a6b88e572d0667a56345f5879eb4f7ddaa4b89593aba8`.
Axes (upstream min/default/max → retained): [{"tag": "opsz", "upstreamMinDefaultMax": [14.0, 14.0, 32.0], "retained": 14.0}, {"tag": "wght", "upstreamMinDefaultMax": [100.0, 400.0, 900.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+0020-007E,U+00A0-00AC,U+00AE-0148,U+014A-01C3,U+01C5-024F,U+0300-0304,U+0306-030A,U+030C,U+030F,U+0313,U+0315,U+031B,U+0323,U+0326-0328,U+032C,U+0337-0338,U+0342-0343,U+0346-036F,U+2000-200B,U+2010-2027,U+202F-2055,U+2057,U+205F,U+2070-2071,U+2074-208E,U+2090-209C,U+20A0-20AF,U+20B1-20B5,U+20B8-20BA,U+20BC-20BF,U+20DB-20DE,U+20E8,U+20F0,U+2100-2101,U+2103,U+2105-2106,U+2109,U+2113,U+2116-2117,U+211E-2122,U+2126,U+212A-212B,U+212E,U+2132,U+213B,U+214D,U+2150-217F,U+2183-2186,U+2189,U+2190-2199,U+21A9-21AA,U+21B0-21B1,U+21B3-21B5,U+21BA-21BB,U+21D0,U+21D2,U+21D4,U+21DE-21DF,U+21E4-21E5,U+21E7,U+21EA,U+2202,U+2205-2206,U+220F,U+2211-2212,U+221A,U+221E,U+222B,U+2236,U+2248,U+2260,U+2264-2265,U+2295-2298,U+2303-2305,U+2318,U+2325-2327,U+232B,U+2380,U+2387,U+238B,U+23CE-23CF,U+2423,U+2460-2468,U+24B6-24CF,U+24EA,U+25A0-25A2,U+25AA,U+25B2-25B3,U+25B6-25B7,U+25BA-25BD,U+25C0-25C1,U+25C4-25C7,U+25CA-25CB,U+25CF,U+25E6,U+25EF,U+2600,U+2605-2606,U+263C,U+2661,U+2665,U+26A0,U+2713,U+2717,U+2756,U+2764,U+2780-2788`.
Missing requested status glyphs (browser fallback): U+2715.

### `latin-sans-04-italic.woff2`

Style: italic; weight: `400 700`; bytes: 112,644; glyphs: 1772; cmap codepoints: 957.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/inter/Inter-Italic%5Bopsz%2Cwght%5D.ttf
Source SHA-256: `acd98e64795781b2058f07b18475e0ecee2a0fe2b42a49e2f9e37d0d6bf66ce6`; source bytes: 906,596.
WOFF2 SHA-256: `21a4ecf7a84cdc11bf53dfc0d175571a56f408dbfe99de23b56233df806a9b97`.
Axes (upstream min/default/max → retained): [{"tag": "opsz", "upstreamMinDefaultMax": [14.0, 14.0, 32.0], "retained": 14.0}, {"tag": "wght", "upstreamMinDefaultMax": [100.0, 400.0, 900.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+0020-007E,U+00A0-00AC,U+00AE-0148,U+014A-01C3,U+01C5-024F,U+0300-0304,U+0306-030A,U+030C,U+030F,U+0313,U+0315,U+031B,U+0323,U+0326-0328,U+032C,U+0337-0338,U+0342-0343,U+0346-036F,U+2000-200B,U+2010-2027,U+202F-2055,U+2057,U+205F,U+2070-2071,U+2074-208E,U+2090-209C,U+20A0-20AF,U+20B1-20B5,U+20B8-20BA,U+20BC-20BF,U+20DB-20DE,U+20E8,U+20F0,U+2100-2101,U+2103,U+2105-2106,U+2109,U+2113,U+2116-2117,U+211E-2122,U+2126,U+212A-212B,U+212E,U+2132,U+213B,U+214D,U+2150-217F,U+2183-2186,U+2189,U+2190-2199,U+21A9-21AA,U+21B0-21B1,U+21B3-21B5,U+21BA-21BB,U+21D0,U+21D2,U+21D4,U+21DE-21DF,U+21E4-21E5,U+21E7,U+21EA,U+2202,U+2205-2206,U+220F,U+2211-2212,U+221A,U+221E,U+222B,U+2236,U+2248,U+2260,U+2264-2265,U+2295-2298,U+2303-2305,U+2318,U+2325-2327,U+232B,U+2380,U+2387,U+238B,U+23CE-23CF,U+2423,U+2460-2468,U+24B6-24CF,U+24EA,U+25A0-25A2,U+25AA,U+25B2-25B3,U+25B6-25B7,U+25BA-25BD,U+25C0-25C1,U+25C4-25C7,U+25CA-25CB,U+25CF,U+25E6,U+25EF,U+2600,U+2605-2606,U+263C,U+2661,U+2665,U+26A0,U+2713,U+2717,U+2756,U+2764,U+2780-2788`.
Missing requested status glyphs (browser fallback): U+2715.

## Montserrat → Dreb Sans 05

ID: `montserrat`; group: Sans-serif; bytes: 250,008.
Upstream metadata: [ofl/montserrat/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/montserrat/METADATA.pb) (bundled verbatim as `metadata/montserrat.pb`).
License/notice files: `licenses/montserrat/OFL.txt`.
Regular-400 face payload: **119,952 bytes**; all four real core styles verified.

### `latin-sans-05-normal.woff2`

Style: normal; weight: `400 700`; bytes: 119,952; glyphs: 1527; cmap codepoints: 669.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/montserrat/Montserrat%5Bwght%5D.ttf
Source SHA-256: `0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7`; source bytes: 744,936.
WOFF2 SHA-256: `d8347c750b3745c652ceb866947e0a0f472e6194c6884fa3b8bc7c1494e52542`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [100.0, 100.0, 900.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-00AC,U+00AE-0183,U+0186-018C,U+018E-0194,U+0196-01A1,U+01A4-01A6,U+01A9,U+01AC-01B9,U+01C0-01F5,U+01F8-0220,U+0222-0223,U+0226-0233,U+0237,U+023A-023E,U+0241-024F,U+0300-0304,U+0306-030D,U+030F-0313,U+0315,U+031B,U+0320,U+0323-0329,U+032D-0332,U+0334-0338,U+034F,U+0358,U+035C-035D,U+035F,U+0361-0362,U+2007-200B,U+2010,U+2012-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+2052,U+2070-2071,U+2074-2079,U+207F-2089,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB-20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BC-20BD,U+20BF,U+2113,U+2116,U+2122,U+2126,U+212A-212B,U+212E,U+2144,U+2153-2154,U+215B-215E,U+2183-2184,U+2190-2199,U+2202,U+2205-2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+24B6,U+24D0,U+25A0-25A1,U+25B2-25B3,U+25B6-25B7,U+25BC-25BD,U+25C0-25C1,U+25C6-25C7,U+25CA,U+25CC`.
Missing requested status glyphs (browser fallback): U+25CF, U+25CB, U+2715, U+21BB.

### `latin-sans-05-italic.woff2`

Style: italic; weight: `400 700`; bytes: 130,056; glyphs: 1551; cmap codepoints: 669.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/montserrat/Montserrat-Italic%5Bwght%5D.ttf
Source SHA-256: `51607f316bc020e59f03cbf51543eecffbea501c0b31d73e5b82927c5cca442c`; source bytes: 762,376.
WOFF2 SHA-256: `6c60b949f015b06df449d3cfa8e4d78c1acda776d019cb8d7fb57867502e0d69`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [100.0, 100.0, 900.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-00AC,U+00AE-0183,U+0186-018C,U+018E-0194,U+0196-01A1,U+01A4-01A6,U+01A9,U+01AC-01B9,U+01C0-01F5,U+01F8-0220,U+0222-0223,U+0226-0233,U+0237,U+023A-023E,U+0241-024F,U+0300-0304,U+0306-030D,U+030F-0313,U+0315,U+031B,U+0320,U+0323-0329,U+032D-0332,U+0334-0338,U+034F,U+0358,U+035C-035D,U+035F,U+0361-0362,U+2007-200B,U+2010,U+2012-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+2052,U+2070-2071,U+2074-2079,U+207F-2089,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB-20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BC-20BD,U+20BF,U+2113,U+2116,U+2122,U+2126,U+212A-212B,U+212E,U+2144,U+2153-2154,U+215B-215E,U+2183-2184,U+2190-2199,U+2202,U+2205-2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+24B6,U+24D0,U+25A0-25A1,U+25B2-25B3,U+25B6-25B7,U+25BC-25BD,U+25C0-25C1,U+25C6-25C7,U+25CA,U+25CC`.
Missing requested status glyphs (browser fallback): U+25CF, U+25CB, U+2715, U+21BB.

## Poppins → Dreb Sans 06

ID: `poppins`; group: Sans-serif; bytes: 80,220.
Upstream metadata: [ofl/poppins/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/poppins/METADATA.pb) (bundled verbatim as `metadata/poppins.pb`).
License/notice files: `licenses/poppins/OFL.txt`.
Regular-400 face payload: **13,120 bytes**; all four real core styles verified.

### `latin-sans-06-normal-400.woff2`

Style: normal; weight: `400`; bytes: 13,120; glyphs: 389; cmap codepoints: 351.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/poppins/Poppins-Regular.ttf
Source SHA-256: `7e65201e9b79159e2300267cc885e16c8dcef2424cdfa09a29bfb0980a94a7ba`; source bytes: 160,316.
WOFF2 SHA-256: `79ef5e370f54780a49ef5f08b42e555d345226e1b3f9ce59773304ecec16f45b`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-0107,U+010A-011B,U+011E-0123,U+0128-0131,U+0136-0137,U+0139-0148,U+014C-015B,U+015E-0165,U+0168-017E,U+018F,U+0192,U+01FC-01FD,U+0218-021B,U+200C-200D,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+20A8,U+20AC,U+20B9-20BA,U+20BD,U+2113,U+2122,U+2126,U+212E,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA,U+25CC`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-sans-06-normal-500.woff2`

Style: normal; weight: `500`; bytes: 12,844; glyphs: 389; cmap codepoints: 351.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/poppins/Poppins-Medium.ttf
Source SHA-256: `90373e7d838d32468438fc3e152dca0bdb12edcab99ea639f158790b1ba1fd05`; source bytes: 158,576.
WOFF2 SHA-256: `db295e7972fc8afaf828a182f1cf247ec4da4d0bac50f2bc336c309611531191`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-0107,U+010A-011B,U+011E-0123,U+0128-0131,U+0136-0137,U+0139-0148,U+014C-015B,U+015E-0165,U+0168-017E,U+018F,U+0192,U+01FC-01FD,U+0218-021B,U+200C-200D,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+20A8,U+20AC,U+20B9-20BA,U+20BD,U+2113,U+2122,U+2126,U+212E,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA,U+25CC`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-sans-06-normal-600.woff2`

Style: normal; weight: `600`; bytes: 13,252; glyphs: 389; cmap codepoints: 351.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/poppins/Poppins-SemiBold.ttf
Source SHA-256: `d3bf1bdaf0550e83da9ac0b1d1d9fe6db086835a83aa28578e609a394b9a0286`; source bytes: 157,312.
WOFF2 SHA-256: `7d4f2cab773a2cd7037a7335b1acb34dc0f0fae77bf36e4b9e335c6b97954e34`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-0107,U+010A-011B,U+011E-0123,U+0128-0131,U+0136-0137,U+0139-0148,U+014C-015B,U+015E-0165,U+0168-017E,U+018F,U+0192,U+01FC-01FD,U+0218-021B,U+200C-200D,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+20A8,U+20AC,U+20B9-20BA,U+20BD,U+2113,U+2122,U+2126,U+212E,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA,U+25CC`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-sans-06-normal-700.woff2`

Style: normal; weight: `700`; bytes: 12,888; glyphs: 389; cmap codepoints: 351.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/poppins/Poppins-Bold.ttf
Source SHA-256: `983676516167748b74de6f4771fb384c664fd913acb8b471122ecacf5da5ea6c`; source bytes: 155,996.
WOFF2 SHA-256: `75c052ec7b1f6c49c2cb630aa49447aa9c43417cf53028a0503214bde5e06550`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-0107,U+010A-011B,U+011E-0123,U+0128-0131,U+0136-0137,U+0139-0148,U+014C-015B,U+015E-0165,U+0168-017E,U+018F,U+0192,U+01FC-01FD,U+0218-021B,U+200C-200D,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+20A8,U+20AC,U+20B9-20BA,U+20BD,U+2113,U+2122,U+2126,U+212E,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA,U+25CC`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-sans-06-italic-400.woff2`

Style: italic; weight: `400`; bytes: 14,096; glyphs: 389; cmap codepoints: 351.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/poppins/Poppins-Italic.ttf
Source SHA-256: `4fa76ae75b40f926420514044722cb97f32186cafd3b38263cc34dad7174d46d`; source bytes: 184,544.
WOFF2 SHA-256: `4b45c5d9ac5e57a98f9047ee83510ff741401fafa215f92ae677e8325bfce69e`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-0107,U+010A-011B,U+011E-0123,U+0128-0131,U+0136-0137,U+0139-0148,U+014C-015B,U+015E-0165,U+0168-017E,U+018F,U+0192,U+01FC-01FD,U+0218-021B,U+200C-200D,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+20A8,U+20AC,U+20B9-20BA,U+20BD,U+2113,U+2122,U+2126,U+212E,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA,U+25CC`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-sans-06-italic-700.woff2`

Style: italic; weight: `700`; bytes: 14,020; glyphs: 389; cmap codepoints: 351.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/poppins/Poppins-BoldItalic.ttf
Source SHA-256: `3572ac8116a0ac7317d342262b29937bcbaf94d8f03f90df6fe666fa7e2fb43a`; source bytes: 179,108.
WOFF2 SHA-256: `0ad08e32b8167c66a5acbf44b1950e5df274478c9e56b602ed6c5dea0fa9fb33`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-0107,U+010A-011B,U+011E-0123,U+0128-0131,U+0136-0137,U+0139-0148,U+014C-015B,U+015E-0165,U+0168-017E,U+018F,U+0192,U+01FC-01FD,U+0218-021B,U+200C-200D,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+20A8,U+20AC,U+20B9-20BA,U+20BD,U+2113,U+2122,U+2126,U+212E,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA,U+25CC`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## Lato → Dreb Sans 07

ID: `lato`; group: Sans-serif; bytes: 593,780.
Upstream metadata: [ofl/lato/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/lato/METADATA.pb) (bundled verbatim as `metadata/lato.pb`).
License/notice files: `licenses/lato/OFL.txt`.
Regular-400 face payload: **97,604 bytes**; all four real core styles verified.

### `latin-sans-07-normal-400.woff2`

Style: normal; weight: `400`; bytes: 97,604; glyphs: 1229; cmap codepoints: 865.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/lato/Lato-Regular.ttf
Source SHA-256: `d636e4683231f931eda222d588e944d082bfd3bdba02f928bee461c0f185b251`; source bytes: 656,568.
WOFF2 SHA-256: `e0b228fd395155b56d7969f508ff30d333685b0ebc0cd04458cf518eeec0bb7e`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0000,U+0020-007E,U+00A0-024F,U+0300-036F,U+2000-2010,U+2012-2022,U+2026,U+202F-2030,U+2032-2034,U+2039-203A,U+203C-203E,U+2044,U+205E-205F,U+2070-2071,U+2074-2094,U+20A0-20B5,U+20B8-20BA,U+20DD,U+2105,U+2113,U+2116-2117,U+2120,U+2122,U+2126,U+212E,U+2132,U+214D-214E,U+2153-215F,U+2183-2184,U+2190-2199,U+21A8,U+2202,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E-221F,U+2229,U+222B,U+2248,U+2260-2261,U+2264-2265,U+2302,U+2310,U+2320-2321,U+2460-2473,U+24EA-24F4,U+24FF-2500,U+2502,U+250C,U+2510,U+2514,U+2518,U+25A1,U+25AA-25AB,U+25CA-25CC,U+25CF,U+25E6,U+2600,U+263C,U+2669,U+2776-277F`.
Missing requested status glyphs (browser fallback): U+25C6, U+2715, U+21BB.

### `latin-sans-07-normal-500.woff2`

Style: normal; weight: `500`; bytes: 95,492; glyphs: 1229; cmap codepoints: 865.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/lato/Lato-Medium.ttf
Source SHA-256: `d3ac182a6833e005745dd75679fbad081c0b12535df4e93ad8ed57817a31a338`; source bytes: 636,396.
WOFF2 SHA-256: `255e39f2f6343ea6445b1c16c1dc506ec181ff09b6cc09e313be28b76103e795`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0000,U+0020-007E,U+00A0-024F,U+0300-036F,U+2000-2010,U+2012-2022,U+2026,U+202F-2030,U+2032-2034,U+2039-203A,U+203C-203E,U+2044,U+205E-205F,U+2070-2071,U+2074-2094,U+20A0-20B5,U+20B8-20BA,U+20DD,U+2105,U+2113,U+2116-2117,U+2120,U+2122,U+2126,U+212E,U+2132,U+214D-214E,U+2153-215F,U+2183-2184,U+2190-2199,U+21A8,U+2202,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E-221F,U+2229,U+222B,U+2248,U+2260-2261,U+2264-2265,U+2302,U+2310,U+2320-2321,U+2460-2473,U+24EA-24F4,U+24FF-2500,U+2502,U+250C,U+2510,U+2514,U+2518,U+25A1,U+25AA-25AB,U+25CA-25CC,U+25CF,U+25E6,U+2600,U+263C,U+2669,U+2776-277F`.
Missing requested status glyphs (browser fallback): U+25C6, U+2715, U+21BB.

### `latin-sans-07-normal-600.woff2`

Style: normal; weight: `600`; bytes: 98,628; glyphs: 1226; cmap codepoints: 865.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/lato/Lato-SemiBold.ttf
Source SHA-256: `71b8b7decbe75a881ed267be539d402bd1e9420b799658aada4e0d1bd5af803c`; source bytes: 668,548.
WOFF2 SHA-256: `984c13d2c642573ab70ba207f12b364e7663aa543bf37430d5292292bba96cc9`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0000,U+0020-007E,U+00A0-024F,U+0300-036F,U+2000-2010,U+2012-2022,U+2026,U+202F-2030,U+2032-2034,U+2039-203A,U+203C-203E,U+2044,U+205E-205F,U+2070-2071,U+2074-2094,U+20A0-20B5,U+20B8-20BA,U+20DD,U+2105,U+2113,U+2116-2117,U+2120,U+2122,U+2126,U+212E,U+2132,U+214D-214E,U+2153-215F,U+2183-2184,U+2190-2199,U+21A8,U+2202,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E-221F,U+2229,U+222B,U+2248,U+2260-2261,U+2264-2265,U+2302,U+2310,U+2320-2321,U+2460-2473,U+24EA-24F4,U+24FF-2500,U+2502,U+250C,U+2510,U+2514,U+2518,U+25A1,U+25AA-25AB,U+25CA-25CC,U+25CF,U+25E6,U+2600,U+263C,U+2669,U+2776-277F`.
Missing requested status glyphs (browser fallback): U+25C6, U+2715, U+21BB.

### `latin-sans-07-normal-700.woff2`

Style: normal; weight: `700`; bytes: 97,088; glyphs: 1230; cmap codepoints: 865.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/lato/Lato-Bold.ttf
Source SHA-256: `8a0aace75d33794eece4b28187bfc1df0bbd2888b5d8a56e01788c8d65d16be1`; source bytes: 656,544.
WOFF2 SHA-256: `a746271b8b6b7ff046aa219c39ebba02898bbe6afe72ce7000251783e68b48e3`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0000,U+0020-007E,U+00A0-024F,U+0300-036F,U+2000-2010,U+2012-2022,U+2026,U+202F-2030,U+2032-2034,U+2039-203A,U+203C-203E,U+2044,U+205E-205F,U+2070-2071,U+2074-2094,U+20A0-20B5,U+20B8-20BA,U+20DD,U+2105,U+2113,U+2116-2117,U+2120,U+2122,U+2126,U+212E,U+2132,U+214D-214E,U+2153-215F,U+2183-2184,U+2190-2199,U+21A8,U+2202,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E-221F,U+2229,U+222B,U+2248,U+2260-2261,U+2264-2265,U+2302,U+2310,U+2320-2321,U+2460-2473,U+24EA-24F4,U+24FF-2500,U+2502,U+250C,U+2510,U+2514,U+2518,U+25A1,U+25AA-25AB,U+25CA-25CC,U+25CF,U+25E6,U+2600,U+263C,U+2669,U+2776-277F`.
Missing requested status glyphs (browser fallback): U+25C6, U+2715, U+21BB.

### `latin-sans-07-italic-400.woff2`

Style: italic; weight: `400`; bytes: 103,176; glyphs: 1214; cmap codepoints: 865.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/lato/Lato-Italic.ttf
Source SHA-256: `e399c44efe1387100531d26c7e4800c5d12251b890d6654a3098c7c679cb1786`; source bytes: 722,900.
WOFF2 SHA-256: `77a65d670d3ccdbb6e1caaee2a3abf71c492ade083e9b098ff7fb155ae609615`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0000,U+0020-007E,U+00A0-024F,U+0300-036F,U+2000-2010,U+2012-2022,U+2026,U+202F-2030,U+2032-2034,U+2039-203A,U+203C-203E,U+2044,U+205E-205F,U+2070-2071,U+2074-2094,U+20A0-20B5,U+20B8-20BA,U+20DD,U+2105,U+2113,U+2116-2117,U+2120,U+2122,U+2126,U+212E,U+2132,U+214D-214E,U+2153-215F,U+2183-2184,U+2190-2199,U+21A8,U+2202,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E-221F,U+2229,U+222B,U+2248,U+2260-2261,U+2264-2265,U+2302,U+2310,U+2320-2321,U+2460-2473,U+24EA-24F4,U+24FF-2500,U+2502,U+250C,U+2510,U+2514,U+2518,U+25A1,U+25AA-25AB,U+25CA-25CC,U+25CF,U+25E6,U+2600,U+263C,U+2669,U+2776-277F`.
Missing requested status glyphs (browser fallback): U+25C6, U+2715, U+21BB.

### `latin-sans-07-italic-700.woff2`

Style: italic; weight: `700`; bytes: 101,792; glyphs: 1215; cmap codepoints: 865.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/lato/Lato-BoldItalic.ttf
Source SHA-256: `62c1b7f0d2e74b45960154c3520efc337b553db0961bfdc950d5618334596cc8`; source bytes: 698,364.
WOFF2 SHA-256: `fbf7cd5d26bed55cc0a7da89f82ce76c302b6a76719ca0f01a4422da7960fb04`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0000,U+0020-007E,U+00A0-024F,U+0300-036F,U+2000-2010,U+2012-2022,U+2026,U+202F-2030,U+2032-2034,U+2039-203A,U+203C-203E,U+2044,U+205E-205F,U+2070-2071,U+2074-2094,U+20A0-20B5,U+20B8-20BA,U+20DD,U+2105,U+2113,U+2116-2117,U+2120,U+2122,U+2126,U+212E,U+2132,U+214D-214E,U+2153-215F,U+2183-2184,U+2190-2199,U+21A8,U+2202,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E-221F,U+2229,U+222B,U+2248,U+2260-2261,U+2264-2265,U+2302,U+2310,U+2320-2321,U+2460-2473,U+24EA-24F4,U+24FF-2500,U+2502,U+250C,U+2510,U+2514,U+2518,U+25A1,U+25AA-25AB,U+25CA-25CC,U+25CF,U+25E6,U+2600,U+263C,U+2669,U+2776-277F`.
Missing requested status glyphs (browser fallback): U+25C6, U+2715, U+21BB.

## Roboto Condensed → Dreb Sans 08

ID: `roboto-condensed`; group: Sans-serif; bytes: 119,440.
Upstream metadata: [ofl/robotocondensed/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/robotocondensed/METADATA.pb) (bundled verbatim as `metadata/roboto-condensed.pb`).
License/notice files: `licenses/roboto-condensed/OFL.txt`.
Regular-400 face payload: **57,164 bytes**; all four real core styles verified.

### `latin-sans-08-normal.woff2`

Style: normal; weight: `400 700`; bytes: 57,164; glyphs: 800; cmap codepoints: 449.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/robotocondensed/RobotoCondensed%5Bwght%5D.ttf
Source SHA-256: `dace262afcee68a5276f200d8026c57221735c0118ab5fda8c2c0d3dc409a8d0`; source bytes: 371,616.
WOFF2 SHA-256: `f59b1fbadc5edae6df0486d7ee623492e779a5549a5286b8679351218cf35549`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [100.0, 400.0, 900.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+0002,U+000D,U+0020-007E,U+00A0-017F,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01F0,U+01FA-01FF,U+0218-021B,U+0237,U+0300-0301,U+0303,U+0309,U+030F,U+0323,U+2000-200B,U+2010-2011,U+2013-2015,U+2017-201E,U+2020-2022,U+2025-2027,U+2030,U+2032-2033,U+2039-203A,U+203C,U+2044,U+2070,U+2074-208E,U+20A3-20A4,U+20A6-20AC,U+20B1,U+20B9-20BA,U+20BC-20BD,U+2105,U+2113,U+2116,U+2122,U+2126,U+212E,U+215B-215E,U+2202,U+2206,U+220F,U+2211-2212,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-sans-08-italic.woff2`

Style: italic; weight: `400 700`; bytes: 62,276; glyphs: 800; cmap codepoints: 449.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/robotocondensed/RobotoCondensed-Italic%5Bwght%5D.ttf
Source SHA-256: `78f643b1923008b00dfc9b371a2ecd4d80a017722925f1a3fac9940be56d1b7d`; source bytes: 388,124.
WOFF2 SHA-256: `37ac935b8726ed42899b2029f8fc190e791bec1065130aeb1d503eccfdfcb704`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [100.0, 400.0, 900.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+0002,U+000D,U+0020-007E,U+00A0-017F,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01F0,U+01FA-01FF,U+0218-021B,U+0237,U+0300-0301,U+0303,U+0309,U+030F,U+0323,U+2000-200B,U+2010-2011,U+2013-2015,U+2017-201E,U+2020-2022,U+2025-2027,U+2030,U+2032-2033,U+2039-203A,U+203C,U+2044,U+2070,U+2074-208E,U+20A3-20A4,U+20A6-20AC,U+20B1,U+20B9-20BA,U+20BC-20BD,U+2105,U+2113,U+2116,U+2122,U+2126,U+212E,U+215B-215E,U+2202,U+2206,U+220F,U+2211-2212,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## Arimo → Dreb Sans 09

ID: `arimo`; group: Sans-serif; bytes: 168,664.
Upstream metadata: [ofl/arimo/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/arimo/METADATA.pb) (bundled verbatim as `metadata/arimo.pb`).
License/notice files: `licenses/arimo/OFL.txt`.
Regular-400 face payload: **79,864 bytes**; all four real core styles verified.

### `latin-sans-09-normal.woff2`

Style: normal; weight: `400 700`; bytes: 79,864; glyphs: 1073; cmap codepoints: 1017.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/arimo/Arimo%5Bwght%5D.ttf
Source SHA-256: `e43898b143ec826ac8cb4034816458a7047fbe0836558de2a1f8c6223ae3e0ca`; source bytes: 496,268.
WOFF2 SHA-256: `fe46b66165db164a898bfdec277e596d167c14605c4d693f1551ab38f4af6948`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [400.0, 400.0, 700.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-024F,U+0300-036F,U+2000-2064,U+2066-2071,U+2074-208E,U+2090-209C,U+20A0-20BE,U+20F0,U+2100-214F,U+2153-2154,U+215B-215E,U+2184,U+2190-2195,U+21A8,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E-221F,U+2229,U+222B,U+2248,U+2260-2261,U+2264-2265,U+2302,U+2310,U+2320-2321,U+2500,U+2502,U+250C,U+2510,U+2514,U+2518,U+251C,U+2524,U+252C,U+2534,U+253C,U+2550-256C,U+2580,U+2584,U+2588,U+258C,U+2590-2593,U+25A0-25A1,U+25AA-25AC,U+25B2,U+25BA,U+25BC,U+25C4,U+25CA-25CC,U+25CF,U+25D8-25D9,U+25E6,U+263A-263C,U+2640,U+2642,U+2660,U+2663,U+2665-2666,U+266A-266B,U+266F`.
Missing requested status glyphs (browser fallback): U+25C6, U+2715, U+21BB.

### `latin-sans-09-italic.woff2`

Style: italic; weight: `400 700`; bytes: 88,800; glyphs: 1078; cmap codepoints: 1017.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/arimo/Arimo-Italic%5Bwght%5D.ttf
Source SHA-256: `a80fc54fd0233c1dfe298577c4d00f5ae81d5bb83510975e473c47e699b7f4ed`; source bytes: 543,196.
WOFF2 SHA-256: `a0d507e50c0dcd2afeb8dcb5e7f026b311f84d5d9ba57111976e1025d215fa49`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [400.0, 400.0, 700.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-024F,U+0300-036F,U+2000-2064,U+2066-2071,U+2074-208E,U+2090-209C,U+20A0-20BE,U+20F0,U+2100-214F,U+2153-2154,U+215B-215E,U+2184,U+2190-2195,U+21A8,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E-221F,U+2229,U+222B,U+2248,U+2260-2261,U+2264-2265,U+2302,U+2310,U+2320-2321,U+2500,U+2502,U+250C,U+2510,U+2514,U+2518,U+251C,U+2524,U+252C,U+2534,U+253C,U+2550-256C,U+2580,U+2584,U+2588,U+258C,U+2590-2593,U+25A0-25A1,U+25AA-25AC,U+25B2,U+25BA,U+25BC,U+25C4,U+25CA-25CC,U+25CF,U+25D8-25D9,U+25E6,U+263A-263C,U+2640,U+2642,U+2660,U+2663,U+2665-2666,U+266A-266B,U+266F`.
Missing requested status glyphs (browser fallback): U+25C6, U+2715, U+21BB.

## Noto Sans → Dreb Sans 10

ID: `noto-sans`; group: Sans-serif; bytes: 186,680.
Upstream metadata: [ofl/notosans/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/notosans/METADATA.pb) (bundled verbatim as `metadata/noto-sans.pb`).
License/notice files: `licenses/noto-sans/OFL.txt`.
Regular-400 face payload: **91,968 bytes**; all four real core styles verified.

### `latin-sans-10-normal.woff2`

Style: normal; weight: `400 700`; bytes: 91,968; glyphs: 1221; cmap codepoints: 929.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf
Source SHA-256: `bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d`; source bytes: 2,049,096.
WOFF2 SHA-256: `6e959337ddc3877f7e9a29d021b294ba9817517c846752f9c7e402420adb2be1`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [100.0, 400.0, 900.0], "retained": [400, 400, 700]}, {"tag": "wdth", "upstreamMinDefaultMax": [62.5, 100.0, 100.0], "retained": 100.0}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-024F,U+0300-036F,U+2000-2064,U+2066-2071,U+2074-208E,U+2090-209C,U+20A0-20C0,U+20F0,U+2100-215F,U+2183-2184,U+2189,U+2212,U+25CC`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-sans-10-italic.woff2`

Style: italic; weight: `400 700`; bytes: 94,712; glyphs: 1224; cmap codepoints: 927.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/notosans/NotoSans-Italic%5Bwdth%2Cwght%5D.ttf
Source SHA-256: `58e6e0ebd1931b29a365aa2d3e2ee9a9e831a3af7cf3ad1462d4e72154f0b291`; source bytes: 2,322,640.
WOFF2 SHA-256: `fae7b764ddc1af6f7eaf53925bab5e6c9fcddee325680abe9ce68d428275dcaa`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [100.0, 400.0, 900.0], "retained": [400, 400, 700]}, {"tag": "wdth", "upstreamMinDefaultMax": [62.5, 100.0, 100.0], "retained": 100.0}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-024F,U+0300-036F,U+2000-2064,U+2066-2071,U+2074-208E,U+2090-209C,U+20A0-20BF,U+20F0,U+2100-215F,U+2184,U+2189,U+2212,U+25CC`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## DM Sans → Dreb Sans 11

ID: `dm-sans`; group: Sans-serif; bytes: 68,088.
Upstream metadata: [ofl/dmsans/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/dmsans/METADATA.pb) (bundled verbatim as `metadata/dm-sans.pb`).
License/notice files: `licenses/dm-sans/OFL.txt`.
Regular-400 face payload: **33,716 bytes**; all four real core styles verified.

### `latin-sans-11-normal.woff2`

Style: normal; weight: `400 700`; bytes: 33,716; glyphs: 463; cmap codepoints: 378.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/dmsans/DMSans%5Bopsz%2Cwght%5D.ttf
Source SHA-256: `8cd08d97e89c24d0aa92edd2f0f4c8ee6195eee9b7c9f154865a58b02f0c1c0d`; source bytes: 240,164.
WOFF2 SHA-256: `9bbcb38d2c691dabfc5961c2ca66e87ecf0acfde77ed42e0b222b0ad7d69b5ac`.
Axes (upstream min/default/max → retained): [{"tag": "opsz", "upstreamMinDefaultMax": [9.0, 9.0, 40.0], "retained": 9.0}, {"tag": "wght", "upstreamMinDefaultMax": [100.0, 400.0, 1000.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+000D,U+0020-007E,U+00A0-00AC,U+00AE-0107,U+010A-011B,U+011E-0123,U+0126-0133,U+0136-0137,U+0139-0148,U+014A-015B,U+015E-0165,U+0168-017E,U+018F,U+0192,U+01FC-01FD,U+0218-021B,U+0237,U+0300-0304,U+0306-0308,U+030A-030C,U+0312,U+0326-0328,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+2074,U+20A8,U+20AC,U+20B9-20BA,U+20BD,U+2113,U+2122,U+2126,U+212E,U+2190-2199,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-sans-11-italic.woff2`

Style: italic; weight: `400 700`; bytes: 34,372; glyphs: 461; cmap codepoints: 378.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/dmsans/DMSans-Italic%5Bopsz%2Cwght%5D.ttf
Source SHA-256: `22259c0cc8237221b80f44c76ba8d36e6bce3cda72779f5b2773643d499720ae`; source bytes: 285,040.
WOFF2 SHA-256: `bea80f45b569eeb24546ebef3159e0f1f3759590398517587ec8b50aed85afc5`.
Axes (upstream min/default/max → retained): [{"tag": "opsz", "upstreamMinDefaultMax": [9.0, 9.0, 40.0], "retained": 9.0}, {"tag": "wght", "upstreamMinDefaultMax": [100.0, 400.0, 1000.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+000D,U+0020-007E,U+00A0-00AC,U+00AE-0107,U+010A-011B,U+011E-0123,U+0126-0133,U+0136-0137,U+0139-0148,U+014A-015B,U+015E-0165,U+0168-017E,U+018F,U+0192,U+01FC-01FD,U+0218-021B,U+0237,U+0300-0304,U+0306-0308,U+030A-030C,U+0312,U+0326-0328,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+2074,U+20A8,U+20AC,U+20B9-20BA,U+20BD,U+2113,U+2122,U+2126,U+212E,U+2190-2199,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## Raleway → Dreb Sans 12

ID: `raleway`; group: Sans-serif; bytes: 181,912.
Upstream metadata: [ofl/raleway/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/raleway/METADATA.pb) (bundled verbatim as `metadata/raleway.pb`).
License/notice files: `licenses/raleway/OFL.txt`.
Regular-400 face payload: **87,996 bytes**; all four real core styles verified.

### `latin-sans-12-normal.woff2`

Style: normal; weight: `400 700`; bytes: 87,996; glyphs: 601; cmap codepoints: 503.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/raleway/Raleway%5Bwght%5D.ttf
Source SHA-256: `8bbcc3eb8275c388f4bcd998832f8a4b943eadbaf6a595205312774b5951aefb`; source bytes: 312,352.
WOFF2 SHA-256: `fe7cded35c9781e5f37039058b8fb5014ef0fea7aaf0c0077d848c8d03ae788d`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [100.0, 100.0, 900.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-017E,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01C4-01CC,U+01E6-01E7,U+01EA-01EB,U+01F1-01F5,U+01FA-021B,U+022A-022D,U+0230-0233,U+0237,U+0300-0304,U+0306-030C,U+030F,U+0311-0312,U+031B,U+0323-0324,U+0326-0328,U+032E,U+0331,U+0335,U+2002-2003,U+2007-200B,U+2010,U+2012-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+2070,U+2074-2079,U+2080-2089,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB-20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BC-20BD,U+2113,U+2116,U+2120,U+2122,U+2126,U+212E,U+2153-2154,U+215B-215E,U+2202,U+2205-2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-sans-12-italic.woff2`

Style: italic; weight: `400 700`; bytes: 93,916; glyphs: 587; cmap codepoints: 498.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/raleway/Raleway-Italic%5Bwght%5D.ttf
Source SHA-256: `96629caf2202183fab46c70237055a7d67e6a5400b85413d45a77ed6f2a0770c`; source bytes: 318,476.
WOFF2 SHA-256: `8a896fde41191b53534b7867ab409d906b2ae5ce66380dd6d91829cbf2e64a60`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [100.0, 100.0, 900.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-017E,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01C4-01CC,U+01E6-01E7,U+01EA-01EB,U+01F1-01F5,U+01FA-021B,U+022A-022D,U+0232-0233,U+0237,U+0300-0304,U+0306-030C,U+030F,U+0311-0312,U+031B,U+0323-0324,U+0326,U+0328,U+032E,U+0331,U+0335,U+2002-2003,U+2007-200B,U+2012-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+2070,U+2074-2079,U+2080-2089,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB-20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20B9,U+20BC-20BD,U+2113,U+2116,U+2120,U+2122,U+2126,U+212E,U+2153-2154,U+215B-215E,U+2202,U+2205-2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## Nunito → Dreb Sans 13

ID: `nunito`; group: Sans-serif; bytes: 96,772.
Upstream metadata: [ofl/nunito/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/nunito/METADATA.pb) (bundled verbatim as `metadata/nunito.pb`).
License/notice files: `licenses/nunito/OFL.txt`.
Regular-400 face payload: **46,852 bytes**; all four real core styles verified.

### `latin-sans-13-normal.woff2`

Style: normal; weight: `400 700`; bytes: 46,852; glyphs: 637; cmap codepoints: 505.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/nunito/Nunito%5Bwght%5D.ttf
Source SHA-256: `bb55a5ca5c2042335b3991af27c4d0705d0ef41cac6164ac737fd8f2a1e85207`; source bytes: 276,932.
WOFF2 SHA-256: `0997139c18612bfee86a09e2c1469572339d379e356369ff5adcdbc193df38fe`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [200.0, 200.0, 1000.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-0132,U+0134-017E,U+0181,U+018A,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01B3-01B4,U+01C4-01CE,U+01D4,U+01E5-01E7,U+01E9-01EB,U+01EF,U+01FA-021B,U+021F,U+0226-0228,U+022A-022D,U+0230-0233,U+0237,U+0300-0304,U+0306-030C,U+030F,U+0311-0312,U+031B,U+0323-0324,U+0326-0328,U+032E,U+0331,U+0335,U+0337-0338,U+2007-200B,U+2010,U+2012-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+2052,U+2070,U+2074-2079,U+2080-2089,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB-20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BC-20BD,U+2113,U+2116,U+2122,U+2126,U+212E,U+2202,U+2205-2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-sans-13-italic.woff2`

Style: italic; weight: `400 700`; bytes: 49,920; glyphs: 637; cmap codepoints: 505.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/nunito/Nunito-Italic%5Bwght%5D.ttf
Source SHA-256: `b520cc871868b0acfca1beda875df7f4a44ebce914f8a89f83977fc9c09529c8`; source bytes: 281,832.
WOFF2 SHA-256: `f8d12411ca3f58844cbd25437f41ab985c41604d053e450d85805531171a87a0`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [200.0, 200.0, 1000.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-0132,U+0134-017E,U+0181,U+018A,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01B3-01B4,U+01C4-01CE,U+01D4,U+01E5-01E7,U+01E9-01EB,U+01EF,U+01FA-021B,U+021F,U+0226-0228,U+022A-022D,U+0230-0233,U+0237,U+0300-0304,U+0306-030C,U+030F,U+0311-0312,U+031B,U+0323-0324,U+0326-0328,U+032E,U+0331,U+0335,U+0337-0338,U+2007-200B,U+2010,U+2012-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+2052,U+2070,U+2074-2079,U+2080-2089,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB-20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BC-20BD,U+2113,U+2116,U+2122,U+2126,U+212E,U+2202,U+2205-2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## Nunito Sans → Dreb Sans 14

ID: `nunito-sans`; group: Sans-serif; bytes: 77,676.
Upstream metadata: [ofl/nunitosans/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/nunitosans/METADATA.pb) (bundled verbatim as `metadata/nunito-sans.pb`).
License/notice files: `licenses/nunito-sans/OFL.txt`.
Regular-400 face payload: **37,544 bytes**; all four real core styles verified.

### `latin-sans-14-normal.woff2`

Style: normal; weight: `400 700`; bytes: 37,544; glyphs: 640; cmap codepoints: 506.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/nunitosans/NunitoSans%5BYTLC%2Copsz%2Cwdth%2Cwght%5D.ttf
Source SHA-256: `f934d7142fb4784bf828da485b7dcbd90c0c80d514e9d49a5da0ed3a1ae2491d`; source bytes: 571,240.
WOFF2 SHA-256: `3599018678f871a17b0a93ce1a2f073c869fbbc5411335ab8013554610b2f8be`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [200.0, 200.0, 1000.0], "retained": [400, 400, 700]}, {"tag": "wdth", "upstreamMinDefaultMax": [75.0, 100.0, 125.0], "retained": 100.0}, {"tag": "opsz", "upstreamMinDefaultMax": [6.0, 12.0, 12.0], "retained": 12.0}, {"tag": "YTLC", "upstreamMinDefaultMax": [440.0, 500.0, 540.0], "retained": 500.0}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-017E,U+0181,U+018A,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01B3-01B4,U+01C4-01CE,U+01D4,U+01E5-01E7,U+01E9-01EB,U+01EF,U+01FA-021B,U+021F,U+0226-0228,U+022A-022D,U+0230-0233,U+0237,U+0300-0304,U+0306-030C,U+030F,U+0311-0312,U+031B,U+0323-0324,U+0326-0328,U+032E,U+0331,U+0335,U+0337-0338,U+2007-200B,U+2010,U+2012-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+2052,U+2070,U+2074-2079,U+2080-2089,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB-20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BC-20BD,U+2113,U+2116,U+2122,U+2126,U+212E,U+2202,U+2205-2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-sans-14-italic.woff2`

Style: italic; weight: `400 700`; bytes: 40,132; glyphs: 639; cmap codepoints: 506.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/nunitosans/NunitoSans-Italic%5BYTLC%2Copsz%2Cwdth%2Cwght%5D.ttf
Source SHA-256: `d9d5db18f3c11221a4fbb553cbc709391c1179964c7eaa4466ef43c78aa4492f`; source bytes: 558,412.
WOFF2 SHA-256: `93a3bf48342499363330ee816f8df693552a2f2bd8ba0487d53e8f2224c4bc34`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [200.0, 200.0, 1000.0], "retained": [400, 400, 700]}, {"tag": "wdth", "upstreamMinDefaultMax": [75.0, 100.0, 125.0], "retained": 100.0}, {"tag": "opsz", "upstreamMinDefaultMax": [6.0, 12.0, 12.0], "retained": 12.0}, {"tag": "YTLC", "upstreamMinDefaultMax": [440.0, 500.0, 540.0], "retained": 500.0}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-017E,U+0181,U+018A,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01B3-01B4,U+01C4-01CE,U+01D4,U+01E5-01E7,U+01E9-01EB,U+01EF,U+01FA-021B,U+021F,U+0226-0228,U+022A-022D,U+0230-0233,U+0237,U+0300-0304,U+0306-030C,U+030F,U+0311-0312,U+031B,U+0323-0324,U+0326-0328,U+032E,U+0331,U+0335,U+0337-0338,U+2007-200B,U+2010,U+2012-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+2052,U+2070,U+2074-2079,U+2080-2089,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB-20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BC-20BD,U+2113,U+2116,U+2122,U+2126,U+212E,U+2202,U+2205-2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## Rubik → Dreb Sans 15

ID: `rubik`; group: Sans-serif; bytes: 105,676.
Upstream metadata: [ofl/rubik/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/rubik/METADATA.pb) (bundled verbatim as `metadata/rubik.pb`).
License/notice files: `licenses/rubik/OFL.txt`.
Regular-400 face payload: **52,188 bytes**; all four real core styles verified.

### `latin-sans-15-normal.woff2`

Style: normal; weight: `400 700`; bytes: 52,188; glyphs: 508; cmap codepoints: 412.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/rubik/Rubik%5Bwght%5D.ttf
Source SHA-256: `1b3a7437ba2af80e465e773ed60c5036d1ba6ace492d89046dbcf18fb31e4e88`; source bytes: 359,804.
WOFF2 SHA-256: `4ea5762092975eace2f3fff7241b6e8b6e9808bd7f46330d1e06a39c763c4653`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [300.0, 300.0, 900.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0020-007E,U+00A0-0161,U+0164-017F,U+0192,U+01FC-01FF,U+0218-021B,U+0237,U+0300-0304,U+0306-0308,U+030A-030C,U+0312,U+0326-0328,U+0335,U+0337-0338,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+2070,U+2074-2079,U+207D-207E,U+2080-2089,U+208D-208E,U+20AA,U+20AC,U+20AE,U+20B4,U+20B8-20B9,U+20BD,U+2116,U+2122,U+212E,U+2153-2154,U+215B-215E,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-sans-15-italic.woff2`

Style: italic; weight: `400 700`; bytes: 53,488; glyphs: 508; cmap codepoints: 412.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/rubik/Rubik-Italic%5Bwght%5D.ttf
Source SHA-256: `08c6c4018a5ada8b517407b46897e46cf6ebb106853fbd3e89addb51d3b59c62`; source bytes: 354,984.
WOFF2 SHA-256: `59c59368f357ef072a4c756ab95e210a54ec9abb35fc12078812f37a15598e09`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [300.0, 300.0, 900.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0020-007E,U+00A0-0161,U+0164-017F,U+0192,U+01FC-01FF,U+0218-021B,U+0237,U+0300-0304,U+0306-0308,U+030A-030C,U+0312,U+0326-0328,U+0335,U+0337-0338,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+2070,U+2074-2079,U+207D-207E,U+2080-2089,U+208D-208E,U+20AA,U+20AC,U+20AE,U+20B4,U+20B8-20B9,U+20BD,U+2116,U+2122,U+212E,U+2153-2154,U+215B-215E,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## Playfair Display → Dreb Serif 01

ID: `playfair-display`; group: Serif; bytes: 136,944.
Upstream metadata: [ofl/playfairdisplay/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/playfairdisplay/METADATA.pb) (bundled verbatim as `metadata/playfair-display.pb`).
License/notice files: `licenses/playfair-display/OFL.txt`.
Regular-400 face payload: **69,396 bytes**; all four real core styles verified.

### `latin-serif-01-normal.woff2`

Style: normal; weight: `400 700`; bytes: 69,396; glyphs: 755; cmap codepoints: 422.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.ttf
Source SHA-256: `c40f2293766a503bc70cce9e512ef844a4ccb7cbcde792fe2ea31d191917d8d6`; source bytes: 300,724.
WOFF2 SHA-256: `6dc8c52aaacbc259b64d2f1f6c3ea515f019e7b943d308f822d830250fcd071e`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [400.0, 400.0, 900.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-00B4,U+00B6-017F,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01B7,U+01CD-01CE,U+01D3-01D4,U+01E4-01E9,U+01EE-01EF,U+01F4-01F5,U+01FE-01FF,U+0218-021B,U+021E-021F,U+0237,U+0300-0304,U+0306-030C,U+0323,U+0326-0328,U+0335,U+0337-0338,U+2009,U+2010,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+2052,U+20AC,U+20B9,U+2105,U+2116,U+2122,U+212A-212B,U+2153-2154,U+2190-2194,U+2196-2199,U+2202,U+220F,U+2211-2212,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25A0-25A1,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-01-italic.woff2`

Style: italic; weight: `400 700`; bytes: 67,548; glyphs: 753; cmap codepoints: 422.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/playfairdisplay/PlayfairDisplay-Italic%5Bwght%5D.ttf
Source SHA-256: `a5e26dc5e2e77fb2803a0bf02fd4f81ee136ec8dea863ccdb0c59a263b21378b`; source bytes: 278,688.
WOFF2 SHA-256: `6ffa4873b2675120ddbdc757a52432ce667bb119ff9766ad5e1aec45e31f4d2c`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [400.0, 400.0, 900.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-00B4,U+00B6-017F,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01B7,U+01CD-01CE,U+01D3-01D4,U+01E4-01E9,U+01EE-01EF,U+01F4-01F5,U+01FE-01FF,U+0218-021B,U+021E-021F,U+0237,U+0300-0304,U+0306-030C,U+0323,U+0326-0328,U+0335,U+0337-0338,U+2009,U+2010,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+2052,U+20AC,U+20B9,U+2105,U+2116,U+2122,U+212A-212B,U+2153-2154,U+2190-2194,U+2196-2199,U+2202,U+220F,U+2211-2212,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25A0-25A1,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## Merriweather → Dreb Serif 02

ID: `merriweather`; group: Serif; bytes: 755,624.
Upstream metadata: [ofl/merriweather/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/merriweather/METADATA.pb) (bundled verbatim as `metadata/merriweather.pb`).
License/notice files: `licenses/merriweather/OFL.txt`.
Regular-400 face payload: **375,376 bytes**; all four real core styles verified.

### `latin-serif-02-normal.woff2`

Style: normal; weight: `400 700`; bytes: 375,376; glyphs: 1218; cmap codepoints: 724.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/merriweather/Merriweather%5Bopsz%2Cwdth%2Cwght%5D.ttf
Source SHA-256: `d0ed0e359e396af7ad05e73dffd11a3a4c326ea0d0283c56bd9361cb2cc86a96`; source bytes: 4,628,080.
WOFF2 SHA-256: `38aa8d12c588151e124749289a90b2fe471ca7761261221f34e0226240056233`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [300.0, 300.0, 900.0], "retained": [400, 400, 700]}, {"tag": "wdth", "upstreamMinDefaultMax": [87.0, 100.0, 112.0], "retained": 100.0}, {"tag": "opsz", "upstreamMinDefaultMax": [18.0, 18.0, 144.0], "retained": 18.0}].
Actual verified cmap coverage: `U+0020-007E,U+00A0-00AC,U+00AE-0148,U+014A-0183,U+0186-018C,U+018E-0194,U+0196-01A1,U+01A4-01A6,U+01A9,U+01AC-01B9,U+01C0-01F5,U+01F8-0220,U+0222-0223,U+0226-0233,U+0237,U+023A-023E,U+0241-024F,U+0300-0304,U+0306-030D,U+030F-0313,U+0315,U+031B,U+0320,U+0323-0329,U+032D-0332,U+0334-0338,U+0358,U+035C-035D,U+035F,U+0361-0362,U+2000-200D,U+2010-2016,U+2018-201E,U+2020-2023,U+2026-2027,U+202F-2030,U+2032-2034,U+2039-203A,U+203C,U+2042,U+2044,U+204A,U+2052,U+2070-2071,U+2074-2079,U+207F-2089,U+20A1-20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BC-20BF,U+2100-2101,U+2105-2106,U+2113,U+2116-2117,U+2122,U+2126,U+212E,U+2144,U+2150-2156,U+2158-215E,U+2183-2184,U+2190-2199,U+2202,U+2205-2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2236,U+2248,U+2260,U+2264-2267,U+2317,U+24B6,U+24D0,U+25A0-25A1,U+25AA-25AB,U+25B2-25B9,U+25BC-25C3,U+25C6-25C7,U+25C9-25CC,U+25CF,U+25E6,U+25FC,U+2611-2612,U+2661,U+2665,U+27A1`.
Missing requested status glyphs (browser fallback): U+2715, U+21BB.

### `latin-serif-02-italic.woff2`

Style: italic; weight: `400 700`; bytes: 380,248; glyphs: 1218; cmap codepoints: 724.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/merriweather/Merriweather-Italic%5Bopsz%2Cwdth%2Cwght%5D.ttf
Source SHA-256: `f68a8f4989258679e4fbaf50aa42400132b5373c2d9d2514ba82ef6e85947a0b`; source bytes: 4,591,168.
WOFF2 SHA-256: `35b89f5f70f05e8362fdab9f1e1e8ee71b1cf1352424eced8ac41810c69a0ef9`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [300.0, 300.0, 900.0], "retained": [400, 400, 700]}, {"tag": "wdth", "upstreamMinDefaultMax": [87.0, 100.0, 112.0], "retained": 100.0}, {"tag": "opsz", "upstreamMinDefaultMax": [18.0, 18.0, 144.0], "retained": 18.0}].
Actual verified cmap coverage: `U+0020-007E,U+00A0-00AC,U+00AE-0148,U+014A-0183,U+0186-018C,U+018E-0194,U+0196-01A1,U+01A4-01A6,U+01A9,U+01AC-01B9,U+01C0-01F5,U+01F8-0220,U+0222-0223,U+0226-0233,U+0237,U+023A-023E,U+0241-024F,U+0300-0304,U+0306-030D,U+030F-0313,U+0315,U+031B,U+0320,U+0323-0329,U+032D-0332,U+0334-0338,U+0358,U+035C-035D,U+035F,U+0361-0362,U+2000-200D,U+2010-2016,U+2018-201E,U+2020-2023,U+2026-2027,U+202F-2030,U+2032-2034,U+2039-203A,U+203C,U+2042,U+2044,U+204A,U+2052,U+2070-2071,U+2074-2079,U+207F-2089,U+20A1-20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BC-20BF,U+2100-2101,U+2105-2106,U+2113,U+2116-2117,U+2122,U+2126,U+212E,U+2144,U+2150-2156,U+2158-215E,U+2183-2184,U+2190-2199,U+2202,U+2205-2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2236,U+2248,U+2260,U+2264-2267,U+2317,U+24B6,U+24D0,U+25A0-25A1,U+25AA-25AB,U+25B2-25B9,U+25BC-25C3,U+25C6-25C7,U+25C9-25CC,U+25CF,U+25E6,U+25FC,U+2611-2612,U+2661,U+2665,U+27A1`.
Missing requested status glyphs (browser fallback): U+2715, U+21BB.

## Lora → Dreb Serif 03

ID: `lora`; group: Serif; bytes: 107,644.
Upstream metadata: [ofl/lora/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/lora/METADATA.pb) (bundled verbatim as `metadata/lora.pb`).
License/notice files: `licenses/lora/OFL.txt`.
Regular-400 face payload: **52,452 bytes**; all four real core styles verified.

### `latin-serif-03-normal.woff2`

Style: normal; weight: `400 700`; bytes: 52,452; glyphs: 497; cmap codepoints: 415.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/lora/Lora%5Bwght%5D.ttf
Source SHA-256: `822a6621ccbe8d97d20ac88c1c41f5615c9c2c202eaa75f272cd452aac6475a7`; source bytes: 212,196.
WOFF2 SHA-256: `4874f8867a7a999b99799dd68c66a551b70b5a41eddc13edfd1b434efdc32346`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [400.0, 400.0, 700.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+000D,U+0020-007E,U+00A0-00AC,U+00AE-0137,U+0139-017F,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01B7,U+01CD-01CE,U+01D3-01D4,U+01E4-01E9,U+01EE-01EF,U+01FE-01FF,U+0218-021B,U+021E-021F,U+0237,U+0300-0304,U+0306-030C,U+0312,U+031B,U+0323,U+0326-0328,U+0335-0336,U+2010,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+2052,U+2074,U+20AC,U+20AE,U+20B4,U+20B8,U+20BA,U+20BD,U+2113,U+2116,U+2122,U+2126,U+212A-212B,U+212E,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-03-italic.woff2`

Style: italic; weight: `400 700`; bytes: 55,192; glyphs: 498; cmap codepoints: 415.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/lora/Lora-Italic%5Bwght%5D.ttf
Source SHA-256: `22d8d8854b53807aa664ca34f2031a9ed57a1d0dea296b8b96cdd3aad937a2b3`; source bytes: 221,232.
WOFF2 SHA-256: `65571a9490bcbffab2e73f25f0ce8dea6ab2cf18328cbccbc132549d6b3081a1`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [400.0, 400.0, 700.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+000D,U+0020-007E,U+00A0-00AC,U+00AE-0137,U+0139-017F,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01B7,U+01CD-01CE,U+01D3-01D4,U+01E4-01E9,U+01EE-01EF,U+01FE-01FF,U+0218-021B,U+021E-021F,U+0237,U+0300-0304,U+0306-030C,U+0312,U+031B,U+0323,U+0326-0328,U+0335-0336,U+2010,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+2052,U+2074,U+20AC,U+20AE,U+20B4,U+20B8,U+20BA,U+20BD,U+2113,U+2116,U+2122,U+2126,U+212A-212B,U+212E,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## Noto Serif → Dreb Serif 04

ID: `noto-serif`; group: Serif; bytes: 191,864.
Upstream metadata: [ofl/notoserif/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/notoserif/METADATA.pb) (bundled verbatim as `metadata/noto-serif.pb`).
License/notice files: `licenses/noto-serif/OFL.txt`.
Regular-400 face payload: **92,276 bytes**; all four real core styles verified.

### `latin-serif-04-normal.woff2`

Style: normal; weight: `400 700`; bytes: 92,276; glyphs: 1186; cmap codepoints: 929.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/notoserif/NotoSerif%5Bwdth%2Cwght%5D.ttf
Source SHA-256: `4d8e6761424656867019081a1a01336f3cb086982682698714054fc33f782713`; source bytes: 1,887,192.
WOFF2 SHA-256: `7072a491cfe241324f2cbb353dc93c77a4959521387e97f7cb7efcea10c78fde`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [100.0, 400.0, 900.0], "retained": [400, 400, 700]}, {"tag": "wdth", "upstreamMinDefaultMax": [62.5, 100.0, 100.0], "retained": 100.0}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-024F,U+0300-036F,U+2000-2064,U+2066-2071,U+2074-208E,U+2090-209C,U+20A0-20C0,U+20F0,U+2100-215F,U+2183-2184,U+2189,U+2212,U+25CC`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-04-italic.woff2`

Style: italic; weight: `400 700`; bytes: 99,588; glyphs: 1190; cmap codepoints: 927.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/notoserif/NotoSerif-Italic%5Bwdth%2Cwght%5D.ttf
Source SHA-256: `e87acbc6c0efd0d9a20d6a8cbbda2b266c14be3a3a6f5af8ec9d7b2460570ad1`; source bytes: 2,448,496.
WOFF2 SHA-256: `5c8d29ffa12ae5af9eed4af1c18405a8582fb48638b66a6d6527dcc04e0043a6`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [100.0, 400.0, 900.0], "retained": [400, 400, 700]}, {"tag": "wdth", "upstreamMinDefaultMax": [62.5, 100.0, 100.0], "retained": 100.0}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-024F,U+0300-036F,U+2000-2064,U+2066-2071,U+2074-208E,U+2090-209C,U+20A0-20BF,U+20F0,U+2100-215F,U+2184,U+2189,U+2212,U+25CC`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## Cormorant Garamond → Dreb Serif 05

ID: `cormorant-garamond`; group: Serif; bytes: 225,260.
Upstream metadata: [ofl/cormorantgaramond/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/cormorantgaramond/METADATA.pb) (bundled verbatim as `metadata/cormorant-garamond.pb`).
License/notice files: `licenses/cormorant-garamond/OFL.txt`.
Regular-400 face payload: **130,680 bytes**; all four real core styles verified.

### `latin-serif-05-normal.woff2`

Style: normal; weight: `400 700`; bytes: 130,680; glyphs: 1899; cmap codepoints: 553.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/cormorantgaramond/CormorantGaramond%5Bwght%5D.ttf
Source SHA-256: `b20b7d9626dd956b2c5e558692ad328b1f19e3275e2782db4fa07670d83f35e0`; source bytes: 1,195,560.
WOFF2 SHA-256: `00ccc2ee1ebf6039760de7b02491553b470ecfcfb06f65776bf7a352fc279326`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [300.0, 300.0, 700.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0020-007E,U+00A0-00B4,U+00B6-017F,U+018F,U+0192,U+0197,U+01A0-01A1,U+01AF-01B0,U+01CD-01DC,U+01E2-01E3,U+01E6-01EB,U+01F8-021B,U+0232-0233,U+0237,U+0244,U+0300-0304,U+0306-030D,U+030F,U+0311,U+031B,U+0323-0324,U+0326-0328,U+032D-032E,U+0331,U+034F,U+0358,U+2000-200D,U+2010-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2026-2029,U+202F-2030,U+2032-2033,U+2039-203A,U+2042-2044,U+205F-2060,U+2063,U+2070,U+2074-207A,U+207D-2089,U+208D-208E,U+20A1,U+20A4,U+20A6-20A7,U+20AA-20AC,U+20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BD,U+2113,U+2116-2117,U+2120,U+2122,U+212E,U+215B-215E,U+2190-2199,U+2202,U+2205,U+220F,U+2211-2212,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25A0-25A1,U+25B2-25B3,U+25B6-25B7,U+25BC-25BD,U+25C0-25C1,U+25C6-25C7,U+25CA-25CB,U+25CF,U+25E6,U+25FB-25FC,U+261C,U+261E,U+263A,U+2766`.
Missing requested status glyphs (browser fallback): U+2715, U+21BB.

### `latin-serif-05-italic.woff2`

Style: italic; weight: `400 700`; bytes: 94,580; glyphs: 1172; cmap codepoints: 554.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/cormorantgaramond/CormorantGaramond-Italic%5Bwght%5D.ttf
Source SHA-256: `0f48ea6abb2084537854f7174c470991a463b13036309e3b50a81511611c530d`; source bytes: 715,644.
WOFF2 SHA-256: `a9be7a62bfb3843510a724efe9f50fdc4c433766132712ee47d32825f2544e0b`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [300.0, 300.0, 700.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-00B4,U+00B6-017F,U+018F,U+0192,U+0197,U+01A0-01A1,U+01AF-01B0,U+01CD-01DC,U+01E2-01E3,U+01E6-01EB,U+01F8-021B,U+0232-0233,U+0237,U+0244,U+0300-0304,U+0306-030D,U+030F,U+0311,U+031B,U+0323-0324,U+0326-0328,U+032D-032E,U+0331,U+034F,U+0358,U+2000-200D,U+2010-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026-2029,U+202F-2030,U+2032-2033,U+2039-203A,U+2042-2044,U+205F-2060,U+2063,U+2070,U+2074-207A,U+207D-2089,U+208D-208E,U+20A1,U+20A4,U+20A6-20A7,U+20AA-20AC,U+20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BD,U+2113,U+2116-2117,U+2120,U+2122,U+212E,U+215B-215E,U+2190-2199,U+2202,U+2205,U+220F,U+2211-2212,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25A0-25A1,U+25B2-25B3,U+25B6-25B7,U+25BC-25BD,U+25C0-25C1,U+25C6-25C7,U+25CA-25CB,U+25CF,U+25E6,U+25FB-25FC,U+261C,U+261E,U+263A,U+2766`.
Missing requested status glyphs (browser fallback): U+2715, U+21BB.

## Libre Baskerville → Dreb Serif 06

ID: `libre-baskerville`; group: Serif; bytes: 107,116.
Upstream metadata: [ofl/librebaskerville/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/librebaskerville/METADATA.pb) (bundled verbatim as `metadata/libre-baskerville.pb`).
License/notice files: `licenses/libre-baskerville/OFL.txt`.
Regular-400 face payload: **54,832 bytes**; all four real core styles verified.

### `latin-serif-06-normal.woff2`

Style: normal; weight: `400 700`; bytes: 54,832; glyphs: 632; cmap codepoints: 546.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/librebaskerville/LibreBaskerville%5Bwght%5D.ttf
Source SHA-256: `05a95421961341c5b2556285e8415df9db27dab4f4abe22b446b3c6a8b916c5d`; source bytes: 171,900.
WOFF2 SHA-256: `a975837f252330ee8d38e13567a05cfd2e0ec5558bf18a821da440b0a49e2cf1`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [400.0, 400.0, 700.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0020-007E,U+00A0-00AC,U+00AE-0148,U+014A-017E,U+0180-0181,U+0186-018A,U+018E-0193,U+0196-019A,U+019D,U+01A4-01A5,U+01A9,U+01AC-01AE,U+01B2-01B6,U+01C4-01ED,U+01F0-01F5,U+01F8-021B,U+021E-021F,U+0226-0233,U+0237,U+023A-023E,U+0241-024F,U+0300-0304,U+0306-0308,U+030A-030C,U+030F,U+0311-0312,U+0323-0328,U+032D-032E,U+0330-0331,U+0335-0338,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2028-2029,U+2030,U+2039-203A,U+2044,U+2070,U+2074-2079,U+2080-2089,U+20A4,U+20AC,U+20B5,U+2116,U+2120,U+2122,U+2153-2154,U+215B-215E,U+2212,U+2215,U+2219,U+2260`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-06-italic.woff2`

Style: italic; weight: `400 700`; bytes: 52,284; glyphs: 634; cmap codepoints: 546.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/librebaskerville/LibreBaskerville-Italic%5Bwght%5D.ttf
Source SHA-256: `223959683dc73ec4437bd61fabaa4b3f22209e22855ffd3aee36ba61a5116e97`; source bytes: 167,456.
WOFF2 SHA-256: `d7e637c90a0d84cd5fe53efec2f5eccc2bad5ad515542e595905675c941a8806`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [400.0, 400.0, 700.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0020-007E,U+00A0-00AC,U+00AE-0148,U+014A-017E,U+0180-0181,U+0186-018A,U+018E-0193,U+0196-019A,U+019D,U+01A4-01A5,U+01A9,U+01AC-01AE,U+01B2-01B6,U+01C4-01ED,U+01F0-01F5,U+01F8-021B,U+021E-021F,U+0226-0233,U+0237,U+023A-023E,U+0241-024F,U+0300-0304,U+0306-0308,U+030A-030C,U+030F,U+0311-0312,U+0323-0328,U+032D-032E,U+0330-0331,U+0335-0338,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2028-2029,U+2030,U+2039-203A,U+2044,U+2070,U+2074-2079,U+2080-2089,U+20A4,U+20AC,U+20B5,U+2116,U+2120,U+2122,U+2153-2154,U+215B-215E,U+2212,U+2215,U+2219,U+2260`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## PT Serif → Dreb Text 07

ID: `pt-serif`; group: Serif; bytes: 191,596.
Upstream metadata: [ofl/ptserif/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ptserif/METADATA.pb) (bundled verbatim as `metadata/pt-serif.pb`).
License/notice files: `licenses/pt-serif/OFL.txt`.
Regular-400 face payload: **50,320 bytes**; all four real core styles verified.

### `latin-serif-07-normal-400.woff2`

Style: normal; weight: `400`; bytes: 50,320; glyphs: 401; cmap codepoints: 367.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ptserif/PT_Serif-Web-Regular.ttf
Source SHA-256: `a4951fade06ff8f09b7673aa81ffb65a8cd409e24d3289a6dc670bc4dda2557a`; source bytes: 359,048.
WOFF2 SHA-256: `c58e1675ec36761e65caff6ad3906efda07b4940692b3bfe6153908bd91b7840`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0020-007E,U+00A0-0109,U+010C-0113,U+0116-011F,U+0122-0127,U+012A-012B,U+012E-0131,U+0134-0137,U+0139-013E,U+0141-0148,U+014C-014D,U+0150-0165,U+016A-0173,U+0178-017F,U+0192,U+01F4-01F5,U+0218-021B,U+0237,U+0301,U+2011,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+2081-2084,U+20AC,U+20B4,U+20B6-20B7,U+20B9-20CF,U+2113,U+2116,U+2122,U+2126,U+212E,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-07-normal-700.woff2`

Style: normal; weight: `700`; bytes: 44,752; glyphs: 401; cmap codepoints: 369.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ptserif/PT_Serif-Web-Bold.ttf
Source SHA-256: `038ba7336bd7ea14f12ad155bed51a4345cac5153275d521dec3ba04021c526e`; source bytes: 339,996.
WOFF2 SHA-256: `65d79ffe981c4e29bcc50ff438ca22283dc62d23c40a9171a3f742b73e621b4b`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0020-007E,U+00A0-0109,U+010C-0113,U+0116-011F,U+0122-0127,U+012A-012B,U+012E-0131,U+0134-0137,U+0139-013E,U+0141-0148,U+014C-014D,U+0150-0165,U+016A-0173,U+0178-017F,U+0192,U+01F4-01F5,U+0218-021B,U+0237,U+0301,U+2011,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+2081-2084,U+20AC,U+20B4,U+20B6-20B7,U+20B9-20CF,U+2113,U+2116,U+2122,U+2126,U+212E,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+22C5,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-07-italic-400.woff2`

Style: italic; weight: `400`; bytes: 52,876; glyphs: 401; cmap codepoints: 367.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ptserif/PT_Serif-Web-Italic.ttf
Source SHA-256: `f57e95ff9dc85691a3b2e193f2028db36f6663939a46c0fc4f286d618b80b7ce`; source bytes: 375,356.
WOFF2 SHA-256: `c2c48bea0b708e5a58181ddd8db3e1df74b0ea1d7b7e2a0da4a67f7757fe8dd7`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0020-007E,U+00A0-0109,U+010C-0113,U+0116-011F,U+0122-0127,U+012A-012B,U+012E-0131,U+0134-0137,U+0139-013E,U+0141-0148,U+014C-014D,U+0150-0165,U+016A-0173,U+0178-017F,U+0192,U+01F4-01F5,U+0218-021B,U+0237,U+0301,U+2011,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+2081-2084,U+20AC,U+20B4,U+20B6-20B7,U+20B9-20CF,U+2113,U+2116,U+2122,U+2126,U+212E,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-07-italic-700.woff2`

Style: italic; weight: `700`; bytes: 43,648; glyphs: 401; cmap codepoints: 369.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ptserif/PT_Serif-Web-BoldItalic.ttf
Source SHA-256: `f003788ba08981eb0988b3557a6f224a53dab49c20e283e8b74d5af3c466f8be`; source bytes: 337,580.
WOFF2 SHA-256: `9c9eabfc72ed6ede440ddd6d08fbdcca9e768308b9951a5ea34dbff83e9820c6`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0020-007E,U+00A0-0109,U+010C-0113,U+0116-011F,U+0122-0127,U+012A-012B,U+012E-0131,U+0134-0137,U+0139-013E,U+0141-0148,U+014C-014D,U+0150-0165,U+016A-0173,U+0178-017F,U+0192,U+01F4-01F5,U+0218-021B,U+0237,U+0301,U+2011,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+2081-2084,U+20AC,U+20B4,U+20B6-20B7,U+20B9-20CF,U+2113,U+2116,U+2122,U+2126,U+212E,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+22C5,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## EB Garamond → Dreb Serif 08

ID: `eb-garamond`; group: Serif; bytes: 351,840.
Upstream metadata: [ofl/ebgaramond/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ebgaramond/METADATA.pb) (bundled verbatim as `metadata/eb-garamond.pb`).
License/notice files: `licenses/eb-garamond/OFL.txt`.
Regular-400 face payload: **168,972 bytes**; all four real core styles verified.

### `latin-serif-08-normal.woff2`

Style: normal; weight: `400 700`; bytes: 168,972; glyphs: 1900; cmap codepoints: 936.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ebgaramond/EBGaramond%5Bwght%5D.ttf
Source SHA-256: `ef9512f92f6d579e5dc75af59a5a4b1b8b47d2eda89e00b954d44520e5369027`; source bytes: 851,176.
WOFF2 SHA-256: `d7af094db0eb1cf7cf24fd9f1699eca01ef8cfdf0b4569e1ec9972f693441f56`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [400.0, 400.0, 800.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-024F,U+0300-033E,U+0340-0345,U+0351,U+0353,U+0357,U+035D,U+0361,U+0364,U+2000-2016,U+2018-201A,U+201C-201E,U+2020-2022,U+2024-2027,U+202A,U+2030,U+2032-2037,U+2039-203A,U+203C-203E,U+2044,U+2047-2049,U+204B,U+204E,U+2057,U+2060,U+2070-2071,U+2074-208E,U+2090-209C,U+20A1,U+20A3-20A9,U+20AB-20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BC-20BD,U+2100-2101,U+2103,U+2105-2106,U+2109,U+210E,U+2112-2113,U+2116,U+211E-2120,U+2122-2123,U+2126-2127,U+212A-212B,U+212E,U+2139,U+214B,U+2150,U+2153-2154,U+215B-215E,U+2160-217F,U+2190-219B,U+219E-21A2,U+21AE,U+21D0-21D3,U+21DA-21DB,U+2202,U+2205-2207,U+220F-2213,U+2215-2216,U+2219-221A,U+221E,U+2223-2226,U+222B,U+2236,U+223C,U+2241,U+2248,U+2260,U+2264-2265,U+226A-226B,U+226E-226F,U+22C5,U+22EF,U+2303,U+2329-232A,U+2474-24B5,U+25A0-25A1,U+25B2-25B3,U+25B6-25B7,U+25BC-25BD,U+25C0-25C1,U+25C6-25C7,U+25CA,U+25E6,U+2619,U+261C-261E,U+267E,U+270A-270C,U+2753,U+2757,U+2766-2767`.
Missing requested status glyphs (browser fallback): U+25CF, U+25CB, U+2715, U+21BB.

### `latin-serif-08-italic.woff2`

Style: italic; weight: `400 700`; bytes: 182,868; glyphs: 1924; cmap codepoints: 928.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ebgaramond/EBGaramond-Italic%5Bwght%5D.ttf
Source SHA-256: `bba2c4499c93c9612b90b9825d32b07da52fce2fe57562a1eb6b833553f93c4e`; source bytes: 754,468.
WOFF2 SHA-256: `cafe4b05041bcb30a9ae0adfc170d847bac8a5e54bde01a7dbe500ee1e5f61ca`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [400.0, 400.0, 800.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-00B1,U+00B4-00B8,U+00BA-024F,U+0300-033E,U+0340-0345,U+0351,U+0353,U+0357,U+035D,U+0361,U+0364,U+2000-201A,U+201C-201E,U+2020-2022,U+2024-2026,U+202A,U+2030,U+2032-2037,U+2039-203A,U+203C-203E,U+2044,U+2047-2049,U+204B,U+204E,U+2057,U+2060,U+2071,U+207A-208E,U+2090-209C,U+20A1,U+20A3-20A9,U+20AB-20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BC-20BD,U+2100-2101,U+2103,U+2105-2106,U+2109,U+210E,U+2112-2113,U+2116,U+211E-2120,U+2122-2123,U+2126-2127,U+212A-212B,U+212E,U+2139,U+214B,U+2150,U+2153-2154,U+215B-215E,U+2160-217F,U+2190-219B,U+219E-21A2,U+21AE,U+21D0-21D3,U+21DA-21DD,U+2202,U+2205-2207,U+220F-2213,U+2215-2216,U+2219-221A,U+221E,U+2223-2226,U+222B,U+2236,U+223C,U+2241,U+2248,U+2260,U+2264-2265,U+226A-226B,U+226E-226F,U+22C5,U+22EF,U+2303,U+2329-232A,U+2474-24B5,U+25A0-25A1,U+25B2-25B3,U+25B6-25B7,U+25BC-25BD,U+25C0-25C1,U+25C6-25C7,U+25CA,U+25E6,U+2619,U+261C-261E,U+267E,U+270A-270C,U+2753,U+2757,U+2766-2767`.
Missing requested status glyphs (browser fallback): U+25CF, U+25CB, U+2715, U+21BB.

## Fraunces → Dreb Serif 09

ID: `fraunces`; group: Serif; bytes: 109,048.
Upstream metadata: [ofl/fraunces/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/fraunces/METADATA.pb) (bundled verbatim as `metadata/fraunces.pb`).
License/notice files: `licenses/fraunces/OFL.txt`.
Regular-400 face payload: **48,976 bytes**; all four real core styles verified.

### `latin-serif-09-normal.woff2`

Style: normal; weight: `400 700`; bytes: 48,976; glyphs: 485; cmap codepoints: 449.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/fraunces/Fraunces%5BSOFT%2CWONK%2Copsz%2Cwght%5D.ttf
Source SHA-256: `177ff6c0f14e5550a3c624247cd1189611d4eb65d000b14944c63d967958abbb`; source bytes: 360,440.
WOFF2 SHA-256: `8c88612fcc23e9f2af0debf30dd48cae734e3c4479658d4bdfabb4819c50a0a8`.
Axes (upstream min/default/max → retained): [{"tag": "opsz", "upstreamMinDefaultMax": [9.0, 9.0, 144.0], "retained": 9.0}, {"tag": "wght", "upstreamMinDefaultMax": [100.0, 900.0, 900.0], "retained": [400, 700, 700]}, {"tag": "SOFT", "upstreamMinDefaultMax": [0.0, 0.0, 100.0], "retained": 0.0}, {"tag": "WONK", "upstreamMinDefaultMax": [0.0, 1.0, 1.0], "retained": 1.0}].
Actual verified cmap coverage: `U+0020-007E,U+00A0-0148,U+014A-017E,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01C4-01CC,U+01D9-01DA,U+01E6-01E7,U+01EA-01EB,U+01FA-021B,U+022A-022D,U+0230-0233,U+0237,U+0300-0304,U+0306-0308,U+030B-030C,U+030F,U+0311-0312,U+0315,U+031B,U+0324,U+0326-0328,U+032E,U+0331,U+2010,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+2052,U+2070,U+2074,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB-20AD,U+20B1-20B2,U+20B5,U+20B9-20BA,U+20BC-20BD,U+2116,U+2122,U+2212,U+2215,U+2219,U+2248,U+2260,U+2264-2265`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-09-italic.woff2`

Style: italic; weight: `400 700`; bytes: 60,072; glyphs: 485; cmap codepoints: 449.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/fraunces/Fraunces-Italic%5BSOFT%2CWONK%2Copsz%2Cwght%5D.ttf
Source SHA-256: `b24448c43702fac4ee856781d461a0dfba8d8e594b6e8e190234b75fed2c0e01`; source bytes: 414,904.
WOFF2 SHA-256: `5c8f91c6cded6f72222263ed639e6a51a889959072c0c95b56cae7394cdede56`.
Axes (upstream min/default/max → retained): [{"tag": "opsz", "upstreamMinDefaultMax": [9.0, 9.0, 144.0], "retained": 9.0}, {"tag": "wght", "upstreamMinDefaultMax": [100.0, 900.0, 900.0], "retained": [400, 700, 700]}, {"tag": "SOFT", "upstreamMinDefaultMax": [0.0, 0.0, 100.0], "retained": 0.0}, {"tag": "WONK", "upstreamMinDefaultMax": [0.0, 1.0, 1.0], "retained": 1.0}].
Actual verified cmap coverage: `U+0020-007E,U+00A0-0148,U+014A-017E,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01C4-01CC,U+01D9-01DA,U+01E6-01E7,U+01EA-01EB,U+01FA-021B,U+022A-022D,U+0230-0233,U+0237,U+0300-0304,U+0306-0308,U+030B-030C,U+030F,U+0311-0312,U+0315,U+031B,U+0323-0324,U+0326-0328,U+032E,U+0331,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+2052,U+2070,U+2074,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB-20AD,U+20B1-20B2,U+20B5,U+20B9-20BA,U+20BC-20BD,U+2116,U+2122,U+2212,U+2215,U+2219,U+2248,U+2260,U+2264-2265`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## Bitter → Dreb Serif 10

ID: `bitter`; group: Serif; bytes: 139,852.
Upstream metadata: [ofl/bitter/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/bitter/METADATA.pb) (bundled verbatim as `metadata/bitter.pb`).
License/notice files: `licenses/bitter/OFL.txt`.
Regular-400 face payload: **69,628 bytes**; all four real core styles verified.

### `latin-serif-10-normal.woff2`

Style: normal; weight: `400 700`; bytes: 69,628; glyphs: 936; cmap codepoints: 547.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/bitter/Bitter%5Bwght%5D.ttf
Source SHA-256: `ef2b9a711fb02f1e5823b34da1b7450e0fc76793b7d733a8b41006e24916d4a7`; source bytes: 328,636.
WOFF2 SHA-256: `ac7ed19f31b3443415df65b14842432398e7f5fa2676f8a1187ec8705c6b3ffc`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [100.0, 100.0, 900.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-00AC,U+00AE-017F,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01C4-01DC,U+01E6-01E7,U+01EA-01EB,U+01F1-01F3,U+01FA-021B,U+022A-022D,U+0230-0233,U+0237,U+0300-0304,U+0306-030C,U+030F,U+0311-0312,U+031B,U+0323-0324,U+0326-0328,U+032E,U+0331,U+0335,U+2007-200B,U+2010,U+2012-2015,U+2017-201E,U+2020-2022,U+2025-2026,U+2030,U+2032-2033,U+2039-203A,U+203C,U+203E,U+2044,U+2070,U+2074-2079,U+207F-2089,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB-20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BC-20BD,U+2105,U+2113,U+2116,U+2122,U+2126,U+212E,U+2153-2154,U+215B-215E,U+2190-2195,U+21A8,U+2202,U+2205-2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E-221F,U+2229,U+222B,U+2248,U+2260-2261,U+2264-2265,U+2302,U+2310,U+2320-2321,U+25A0-25A1,U+25B2-25B3,U+25B6-25B7,U+25BC-25BD,U+25C0-25C1,U+25C6-25C7,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25CB, U+2715, U+21BB.

### `latin-serif-10-italic.woff2`

Style: italic; weight: `400 700`; bytes: 70,224; glyphs: 934; cmap codepoints: 547.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/bitter/Bitter-Italic%5Bwght%5D.ttf
Source SHA-256: `5e6e0af503171c9d7b4be7a22c16f474d7a638cf83a80051d825bcc58d664bc3`; source bytes: 317,652.
WOFF2 SHA-256: `9e5b03182e69c7c30ebfd39d842f13b0b290f85dfade1b1f6ce339d3dc13c87b`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [100.0, 100.0, 900.0], "retained": [400, 400, 700]}].
Actual verified cmap coverage: `U+0000,U+000D,U+0020-007E,U+00A0-00AC,U+00AE-017F,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01C4-01DC,U+01E6-01E7,U+01EA-01EB,U+01F1-01F3,U+01FA-021B,U+022A-022D,U+0230-0233,U+0237,U+0300-0304,U+0306-030C,U+030F,U+0311-0312,U+031B,U+0323-0324,U+0326-0328,U+032E,U+0331,U+0335,U+2007-200B,U+2010,U+2012-2015,U+2017-201E,U+2020-2022,U+2025-2026,U+2030,U+2032-2033,U+2039-203A,U+203C,U+203E,U+2044,U+2070,U+2074-2079,U+207F-2089,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB-20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BC-20BD,U+2105,U+2113,U+2116,U+2122,U+2126,U+212E,U+2153-2154,U+215B-215E,U+2190-2195,U+21A8,U+2202,U+2205-2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E-221F,U+2229,U+222B,U+2248,U+2260-2261,U+2264-2265,U+2302,U+2310,U+2320-2321,U+25A0-25A1,U+25B2-25B3,U+25B6-25B7,U+25BC-25BD,U+25C0-25C1,U+25C6-25C7,U+25CA`.
Missing requested status glyphs (browser fallback): U+25CF, U+25CB, U+2715, U+21BB.

## Source Serif 4 → Dreb Serif 11

ID: `source-serif-4`; group: Serif; bytes: 133,296.
Upstream metadata: [ofl/sourceserif4/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/sourceserif4/METADATA.pb) (bundled verbatim as `metadata/source-serif-4.pb`).
License/notice files: `licenses/source-serif-4/OFL.txt`.
Regular-400 face payload: **73,056 bytes**; all four real core styles verified.

### `latin-serif-11-normal.woff2`

Style: normal; weight: `400 700`; bytes: 73,056; glyphs: 867; cmap codepoints: 493.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/sourceserif4/SourceSerif4%5Bopsz%2Cwght%5D.ttf
Source SHA-256: `97b2d4da6e3cb494b5a1e66ae176914d852ccabef49e0c02c0df25f3e39aca0b`; source bytes: 1,209,508.
WOFF2 SHA-256: `d8fedacbbed11efdf4a9a9818aa85d72e3acac561a7f385949e5bf02431c28d0`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [200.0, 400.0, 900.0], "retained": [400, 400, 700]}, {"tag": "opsz", "upstreamMinDefaultMax": [8.0, 20.0, 60.0], "retained": 20.0}].
Actual verified cmap coverage: `U+0020-007E,U+00A0-012B,U+012E-0131,U+0134-0165,U+0168-017F,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01CD-01DC,U+01E6-01E7,U+01F8-01F9,U+0218-021B,U+0237,U+0300-0304,U+0306-030C,U+031B,U+0323-0324,U+0326-0329,U+032E,U+0331,U+2002-2007,U+2009-200B,U+2010,U+2012-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2025-2026,U+202F-2030,U+2032-2033,U+2039-203A,U+203C,U+2044,U+2047-2049,U+2070-2071,U+2074-2079,U+207D-2089,U+208D-208E,U+20A1,U+20A4,U+20A6-20A7,U+20A9,U+20AB-20AC,U+20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BD,U+20BF,U+2113,U+2116-2117,U+2120,U+2122,U+2126,U+212E,U+2153-2154,U+215B-215E,U+2190-2193,U+2196-2199,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25A0,U+25B2-25B3,U+25B6-25B7,U+25BC-25BD,U+25C0-25C1,U+25C6,U+25C9-25CA,U+2610-2611,U+266A,U+2713,U+2752`.
Missing requested status glyphs (browser fallback): U+25CF, U+25CB, U+2715, U+21BB.

### `latin-serif-11-italic.woff2`

Style: italic; weight: `400 700`; bytes: 60,240; glyphs: 681; cmap codepoints: 493.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/sourceserif4/SourceSerif4-Italic%5Bopsz%2Cwght%5D.ttf
Source SHA-256: `15fbc7e4679489a501998c3669272637a6646388ef7e4bd77eebb5bf967a1f42`; source bytes: 855,432.
WOFF2 SHA-256: `1c2a8ea0d92450734558b78dfb75805b67edb1fff0642eddf4121cd38ceed3f7`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [200.0, 400.0, 900.0], "retained": [400, 400, 700]}, {"tag": "opsz", "upstreamMinDefaultMax": [8.0, 20.0, 60.0], "retained": 20.0}].
Actual verified cmap coverage: `U+0020-007E,U+00A0-012B,U+012E-0131,U+0134-0165,U+0168-017F,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01CD-01DC,U+01E6-01E7,U+01F8-01F9,U+0218-021B,U+0237,U+0300-0304,U+0306-030C,U+031B,U+0323-0324,U+0326-0329,U+032E,U+0331,U+2002-2007,U+2009-200B,U+2010,U+2012-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2025-2026,U+202F-2030,U+2032-2033,U+2039-203A,U+203C,U+2044,U+2047-2049,U+2070-2071,U+2074-2079,U+207D-2089,U+208D-208E,U+20A1,U+20A4,U+20A6-20A7,U+20A9,U+20AB-20AC,U+20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BD,U+20BF,U+2113,U+2116-2117,U+2120,U+2122,U+2126,U+212E,U+2153-2154,U+215B-215E,U+2190-2193,U+2196-2199,U+2202,U+2206,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25A0,U+25B2-25B3,U+25B6-25B7,U+25BC-25BD,U+25C0-25C1,U+25C6,U+25C9-25CA,U+2610-2611,U+266A,U+2713,U+2752`.
Missing requested status glyphs (browser fallback): U+25CF, U+25CB, U+2715, U+21BB.

## Newsreader → Dreb Serif 12

ID: `newsreader`; group: Serif; bytes: 137,608.
Upstream metadata: [ofl/newsreader/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/newsreader/METADATA.pb) (bundled verbatim as `metadata/newsreader.pb`).
License/notice files: `licenses/newsreader/OFL.txt`.
Regular-400 face payload: **65,076 bytes**; all four real core styles verified.

### `latin-serif-12-normal.woff2`

Style: normal; weight: `400 700`; bytes: 65,076; glyphs: 516; cmap codepoints: 448.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/newsreader/Newsreader%5Bopsz%2Cwght%5D.ttf
Source SHA-256: `8a08d13f8a6c0d51be379a60af84f945f65369a67e509ee3c3bdcc421254d7c1`; source bytes: 451,664.
WOFF2 SHA-256: `9e797b34ca66354024aa946db9a9ba1721a5ebc64d5bf3c118cb46ca798118d9`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [200.0, 400.0, 800.0], "retained": [400, 400, 700]}, {"tag": "opsz", "upstreamMinDefaultMax": [6.0, 18.0, 72.0], "retained": 18.0}].
Actual verified cmap coverage: `U+0020-007E,U+00A0-0131,U+0134-0148,U+014A-017E,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01C4-01CC,U+01E6-01E7,U+01EA-01EB,U+01FA-021B,U+022A-022D,U+0230-0233,U+0237,U+0300-0304,U+0306-030C,U+030F,U+0311-0312,U+031B,U+0323-0324,U+0326-0328,U+032E,U+0331,U+0335,U+2010,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+2052,U+2070,U+2074,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB-20AD,U+20B1-20B2,U+20B5,U+20B9-20BA,U+20BC-20BD,U+2116,U+2122,U+2212,U+2215,U+2219,U+2248,U+2260,U+2264-2265`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-12-italic.woff2`

Style: italic; weight: `400 700`; bytes: 72,532; glyphs: 516; cmap codepoints: 448.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/newsreader/Newsreader-Italic%5Bopsz%2Cwght%5D.ttf
Source SHA-256: `796668611f80b64d5adf182fde3b6f29ed83b4e7cbec7b96937e84ac01364792`; source bytes: 495,684.
WOFF2 SHA-256: `fceb5525f30f7fb34bfcf097bf110ee7df3ca101f7af23df5a24e8968fba9943`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [200.0, 400.0, 800.0], "retained": [400, 400, 700]}, {"tag": "opsz", "upstreamMinDefaultMax": [6.0, 18.0, 72.0], "retained": 18.0}].
Actual verified cmap coverage: `U+0020-007E,U+00A0-0131,U+0134-0148,U+014A-017E,U+018F,U+0192,U+01A0-01A1,U+01AF-01B0,U+01C4-01CC,U+01E6-01E7,U+01EA-01EB,U+01FA-021B,U+022A-022D,U+0230-0233,U+0237,U+0300-0304,U+0306-030C,U+030F,U+0311-0312,U+031B,U+0323-0324,U+0326-0328,U+032E,U+0331,U+0335,U+2010,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2032-2033,U+2039-203A,U+2044,U+2052,U+2070,U+2074,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB-20AD,U+20B1-20B2,U+20B5,U+20B9-20BA,U+20BC-20BD,U+2116,U+2122,U+2212,U+2215,U+2219,U+2248,U+2260,U+2264-2265`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## Crimson Text → Dreb Serif 13

ID: `crimson-text`; group: Serif; bytes: 198,396.
Upstream metadata: [ofl/crimsontext/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/crimsontext/METADATA.pb) (bundled verbatim as `metadata/crimson-text.pb`).
License/notice files: `licenses/crimson-text/OFL.txt`.
Regular-400 face payload: **38,596 bytes**; all four real core styles verified.

### `latin-serif-13-normal-400.woff2`

Style: normal; weight: `400`; bytes: 38,596; glyphs: 479; cmap codepoints: 420.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/crimsontext/CrimsonText-Regular.ttf
Source SHA-256: `48e6c5d5ad1d01599d374ecb817e15890d1feb3b8a3a88e527d44c90389e1f06`; source bytes: 107,200.
WOFF2 SHA-256: `115475a3c83d173f7f38510771ae6f7c89902cbaad70414d337067af584f1344`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+000D,U+0020-007E,U+00A0-00AC,U+00AE-0148,U+014A-017E,U+0189,U+01A0-01A1,U+01AF-01B0,U+01CD-01D4,U+01D6-01DC,U+01E2-01E3,U+01FB-01FF,U+0218-021B,U+0232-0233,U+0237,U+0300-030C,U+0312,U+0323,U+0326-0328,U+2010-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2024,U+2026,U+2030,U+2032-2033,U+2038-203A,U+203E,U+2044,U+2070,U+2074,U+2080-2084,U+20AC,U+2122,U+2190-2193,U+2202,U+2211-2213,U+2215,U+221A,U+221D-221E,U+2260,U+2264-2265,U+2619,U+2767`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-13-normal-600.woff2`

Style: normal; weight: `600`; bytes: 40,068; glyphs: 478; cmap codepoints: 420.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/crimsontext/CrimsonText-SemiBold.ttf
Source SHA-256: `802e84000740fec2a9fbe0ae09b6b6811bd86a78a0173b15d44450a1530e9410`; source bytes: 111,176.
WOFF2 SHA-256: `53ff47f332b29cc608d4e961a1635c67da1f8e2e757134f7905df2c5f28c4336`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+000D,U+0020-007E,U+00A0-00AC,U+00AE-0148,U+014A-017E,U+0189,U+01A0-01A1,U+01AF-01B0,U+01CD-01D4,U+01D6-01DC,U+01E2-01E3,U+01FB-01FF,U+0218-021B,U+0232-0233,U+0237,U+0300-030C,U+0312,U+0323,U+0326-0328,U+2010-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2024,U+2026,U+2030,U+2032-2033,U+2038-203A,U+203E,U+2044,U+2070,U+2074,U+2080-2084,U+20AC,U+2122,U+2190-2193,U+2202,U+2211-2213,U+2215,U+221A,U+221D-221E,U+2260,U+2264-2265,U+2619,U+2767`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-13-normal-700.woff2`

Style: normal; weight: `700`; bytes: 39,100; glyphs: 478; cmap codepoints: 420.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/crimsontext/CrimsonText-Bold.ttf
Source SHA-256: `a3a0765fc5e8d0b49b540a23aefe0184887dd79f06a0bdf4db7035cea6befa93`; source bytes: 112,796.
WOFF2 SHA-256: `e00e656ffff7abd9f68aaf7a921d462a975ee93fb3141409c83836351a061fa0`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+000D,U+0020-007E,U+00A0-00AC,U+00AE-0148,U+014A-017E,U+0189,U+01A0-01A1,U+01AF-01B0,U+01CD-01D4,U+01D6-01DC,U+01E2-01E3,U+01FB-01FF,U+0218-021B,U+0232-0233,U+0237,U+0300-030C,U+0312,U+0323,U+0326-0328,U+2010-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2024,U+2026,U+2030,U+2032-2033,U+2038-203A,U+203E,U+2044,U+2070,U+2074,U+2080-2084,U+20AC,U+2122,U+2190-2193,U+2202,U+2211-2213,U+2215,U+221A,U+221D-221E,U+2260,U+2264-2265,U+2619,U+2767`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-13-italic-400.woff2`

Style: italic; weight: `400`; bytes: 39,940; glyphs: 478; cmap codepoints: 420.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/crimsontext/CrimsonText-Italic.ttf
Source SHA-256: `4ed1699ac7c64e8b3d33f6bb8323c3d7206b0d7bacb9ee2d65c697e6014d29de`; source bytes: 110,216.
WOFF2 SHA-256: `89253dd7f21c5d2b7be76255a103aa9078fa2405a35968dd36666cf9e82e2941`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+000D,U+0020-007E,U+00A0-00AC,U+00AE-0148,U+014A-017E,U+0189,U+01A0-01A1,U+01AF-01B0,U+01CD-01D4,U+01D6-01DC,U+01E2-01E3,U+01FB-01FF,U+0218-021B,U+0232-0233,U+0237,U+0300-030C,U+0312,U+0323,U+0326-0328,U+2010-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2024,U+2026,U+2030,U+2032-2033,U+2038-203A,U+203E,U+2044,U+2070,U+2074,U+2080-2084,U+20AC,U+2122,U+2190-2193,U+2202,U+2211-2213,U+2215,U+221A,U+221D-221E,U+2260,U+2264-2265,U+2619,U+2767`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-13-italic-700.woff2`

Style: italic; weight: `700`; bytes: 40,692; glyphs: 478; cmap codepoints: 420.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/crimsontext/CrimsonText-BoldItalic.ttf
Source SHA-256: `467013e913e46304760461c46661c994b2aa1769e3fbd31371026300315181b4`; source bytes: 115,112.
WOFF2 SHA-256: `26f9aaaa9973f8fb19cc0b4773fefa2fd1157eafc085b855d5adbc8dc4ba63be`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+000D,U+0020-007E,U+00A0-00AC,U+00AE-0148,U+014A-017E,U+0189,U+01A0-01A1,U+01AF-01B0,U+01CD-01D4,U+01D6-01DC,U+01E2-01E3,U+01FB-01FF,U+0218-021B,U+0232-0233,U+0237,U+0300-030C,U+0312,U+0323,U+0326-0328,U+2010-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2024,U+2026,U+2030,U+2032-2033,U+2038-203A,U+203E,U+2044,U+2070,U+2074,U+2080-2084,U+20AC,U+2122,U+2190-2193,U+2202,U+2211-2213,U+2215,U+221A,U+221D-221E,U+2260,U+2264-2265,U+2619,U+2767`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## Arvo → Dreb Serif 14

ID: `arvo`; group: Serif; bytes: 69,952.
Upstream metadata: [ofl/arvo/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/arvo/METADATA.pb) (bundled verbatim as `metadata/arvo.pb`).
License/notice files: `licenses/arvo/OFL.txt`.
Regular-400 face payload: **17,676 bytes**; all four real core styles verified.

### `latin-serif-14-normal-400.woff2`

Style: normal; weight: `400`; bytes: 17,676; glyphs: 220; cmap codepoints: 216.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/arvo/Arvo-Regular.ttf
Source SHA-256: `f41bd41471ec2db7140351bdde614da5341524503598ff7fe79f3c89c13b605e`; source bytes: 38,780.
WOFF2 SHA-256: `869291d5650b224f51ced59902ed912e21eb2e4a1b8fa91893212e6c59219070`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0020-007E,U+00A1-00FF,U+010C-010D,U+0131,U+0160-0161,U+0178,U+017D-017E,U+2013-2014,U+2018-2019,U+201C-201E,U+2022,U+2026,U+2039-203A,U+2044,U+2074,U+2082,U+2084,U+2212,U+2215,U+2219`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-14-normal-700.woff2`

Style: normal; weight: `700`; bytes: 17,540; glyphs: 217; cmap codepoints: 212.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/arvo/Arvo-Bold.ttf
Source SHA-256: `6239b2edee762db0ab99343137c9ba15ae81fc843da2e76a0a395781748cc21f`; source bytes: 37,652.
WOFF2 SHA-256: `1824d8242ee2d035516b3d017eb3b7ef71bbec375fec1f469705acd0adfe60a8`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0020-007E,U+00A1-00AC,U+00AE-00FF,U+010C-010D,U+0131,U+0160-0161,U+0178,U+017D-017E,U+2013-2014,U+2018-2019,U+201C-201E,U+2022,U+2026,U+2039-203A,U+2044,U+2082,U+2084,U+2212`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-14-italic-400.woff2`

Style: italic; weight: `400`; bytes: 17,092; glyphs: 216; cmap codepoints: 212.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/arvo/Arvo-Italic.ttf
Source SHA-256: `a2eb63a0771b8d13d8e54bf650a02aef813eeaa2e10f6298358e6b15d26c6686`; source bytes: 35,156.
WOFF2 SHA-256: `f0eccfb26e87e49e85c4b6bdc60c3e8c7c18fbe9966df8359dba9b2a1d29e076`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0020-007E,U+00A1-00FF,U+010C-010D,U+0131,U+0178,U+2013-2014,U+2018-2019,U+201C-201E,U+2022,U+2026,U+2039-203A,U+2044,U+2074,U+2082,U+2084,U+2212,U+2215,U+2219`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-14-italic-700.woff2`

Style: italic; weight: `700`; bytes: 17,644; glyphs: 219; cmap codepoints: 214.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/arvo/Arvo-BoldItalic.ttf
Source SHA-256: `fc29e57f5558873e41ca9ff9a9c77521565f12c6972756d0fbcc592e1f0f4edb`; source bytes: 36,872.
WOFF2 SHA-256: `fa8b84d10ed549836fd4513af7955684ef9c58bed6d761271a5620966cbb8a6e`.
Axes (upstream min/default/max → retained): static upstream face.
Actual verified cmap coverage: `U+0020-007F,U+00A1-00AC,U+00AE-00FF,U+010C-010D,U+0131,U+0160-0161,U+0178,U+017D-017E,U+2013-2014,U+2018-2019,U+201C-201E,U+2022,U+2026,U+2039-203A,U+2044,U+2082,U+2084,U+2212,U+2215`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## Bodoni Moda → Dreb Serif 15

ID: `bodoni-moda`; group: Serif; bytes: 83,096.
Upstream metadata: [ofl/bodonimoda/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/bodonimoda/METADATA.pb) (bundled verbatim as `metadata/bodoni-moda.pb`).
License/notice files: `licenses/bodoni-moda/OFL.txt`.
Regular-400 face payload: **38,856 bytes**; all four real core styles verified.

### `latin-serif-15-normal.woff2`

Style: normal; weight: `400 700`; bytes: 38,856; glyphs: 535; cmap codepoints: 399.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/bodonimoda/BodoniModa%5Bopsz%2Cwght%5D.ttf
Source SHA-256: `550f5e34ee0a828d7941b1fe9bc58b34e5260d3f33a61532e6d0a0114e79a5cf`; source bytes: 162,104.
WOFF2 SHA-256: `154e24600f2dfa840be2ffba2424904ed8da719cdd376bfe666d37b08adb5dac`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [400.0, 400.0, 900.0], "retained": [400, 400, 700]}, {"tag": "opsz", "upstreamMinDefaultMax": [6.0, 11.0, 96.0], "retained": 11.0}].
Actual verified cmap coverage: `U+000D,U+0020-007E,U+00A0-00AC,U+00AE-017F,U+0192,U+0212-0213,U+0218-021B,U+0237,U+0300-0304,U+0306-0308,U+030A-030C,U+0311-0312,U+0323,U+0326-0328,U+2000-200B,U+2010-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030-2031,U+2039-203A,U+203D-203E,U+2044,U+2074,U+20AC,U+2116,U+2122,U+2202,U+2205,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA,U+2761`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

### `latin-serif-15-italic.woff2`

Style: italic; weight: `400 700`; bytes: 44,240; glyphs: 535; cmap codepoints: 399.
Source: https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/bodonimoda/BodoniModa-Italic%5Bopsz%2Cwght%5D.ttf
Source SHA-256: `dfff1619f8f6871c6372f8855b67211f9a73b4e93d45aca868cd8f46a48622de`; source bytes: 176,300.
WOFF2 SHA-256: `ff88f810d436822fb3947d1a584528fdb9a93b2bc68d73a1d3298bf64d7ccaa8`.
Axes (upstream min/default/max → retained): [{"tag": "wght", "upstreamMinDefaultMax": [400.0, 400.0, 900.0], "retained": [400, 400, 700]}, {"tag": "opsz", "upstreamMinDefaultMax": [6.0, 11.0, 96.0], "retained": 11.0}].
Actual verified cmap coverage: `U+000D,U+0020-007E,U+00A0-00AC,U+00AE-017F,U+0192,U+0212-0213,U+0218-021B,U+0237,U+0300-0304,U+0306-0308,U+030A-030C,U+0311-0312,U+0323,U+0326-0328,U+2000-200B,U+2010-2015,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030-2031,U+2039-203A,U+203D-203E,U+2044,U+2074,U+20AC,U+2116,U+2122,U+2202,U+2205,U+220F,U+2211-2212,U+2215,U+2219-221A,U+221E,U+222B,U+2248,U+2260,U+2264-2265,U+25CA,U+2761`.
Missing requested status glyphs (browser fallback): U+25CF, U+25C6, U+25CB, U+2715, U+21BB.

## Pinned non-binary sources

All acquired source records (including TTFs) are hash/size/URL pinned in `sources.lock.json`. Verbatim bundled metadata and notices:

- [ofl/arimo/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/arimo/METADATA.pb): 1256 bytes; SHA-256 `3ea06d7e7151a1241987ffa38efa1bfa1f6e8b1f5b6a0d0af393577b53a8091c`.
- [ofl/arimo/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/arimo/OFL.txt): 4384 bytes; SHA-256 `11cce536cd2f3864d767003af5dcd739e2e15818cf2279b6175edeadd3960992`.
- [ofl/arvo/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/arvo/METADATA.pb): 1071 bytes; SHA-256 `541fd3b9c038ece8d277df69ae9fbd77eea325d3eaa8db5f7d53da32703d9052`.
- [ofl/arvo/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/arvo/OFL.txt): 4393 bytes; SHA-256 `359671bf16c00cae69cb66d041296b2adc7a4becd73a463cb8c5e101d97c7986`.
- [ofl/bitter/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/bitter/METADATA.pb): 1248 bytes; SHA-256 `15a488064d44b2405c6a35befff3ba87ceb002db947793f99c6fd509b2a19c39`.
- [ofl/bitter/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/bitter/OFL.txt): 4424 bytes; SHA-256 `152a1e283e23b42c4940da4c72f2f5bebaa17969cb77c76d7af05903846006f1`.
- [ofl/bodonimoda/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/bodonimoda/METADATA.pb): 1468 bytes; SHA-256 `f4ba29335a79d264135d7062fc1c79e8fa9a076719e99095416334e27aa00489`.
- [ofl/bodonimoda/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/bodonimoda/OFL.txt): 4400 bytes; SHA-256 `931dfe2e0cd3c9443295f5c1d754b8a8403bf060df50c1d5900267ade83d0046`.
- [ofl/cormorantgaramond/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/cormorantgaramond/METADATA.pb): 1426 bytes; SHA-256 `faa16a5e79613ca7cadd599ada1f4cf6891f3cb6731631fbed2a0b18a342e556`.
- [ofl/cormorantgaramond/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/cormorantgaramond/OFL.txt): 4387 bytes; SHA-256 `60700d351cac4650c51f3f9db318d2a420f8b45052dba2715eb5fec41f0f6956`.
- [ofl/crimsontext/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/crimsontext/METADATA.pb): 2823 bytes; SHA-256 `c5ca01516f7cf8769bbeaede301300db4a28e5a246090bcb7ed9091b37175d0d`.
- [ofl/crimsontext/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/crimsontext/OFL.txt): 4393 bytes; SHA-256 `50fd67cddc097377a5c871e8452b778bc5aedfa3480a705cb27c5e3a078218df`.
- [ofl/dmsans/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/dmsans/METADATA.pb): 1283 bytes; SHA-256 `55b3697a416f7d08c093918a4019a75cca7186c64bc56b1bb23e197a5d559dee`.
- [ofl/dmsans/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/dmsans/OFL.txt): 4482 bytes; SHA-256 `9af36190332437f5ecd09974de43c1f7c77a310a996cdd8ceb25628b458840e1`.
- [ofl/ebgaramond/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ebgaramond/METADATA.pb): 1457 bytes; SHA-256 `be94098be975a66281842ed599baefa14959eff9da14c87250678e905f6043f2`.
- [ofl/ebgaramond/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ebgaramond/OFL.txt): 4398 bytes; SHA-256 `0985066662eb755ed3683ae5482a81a9195b49ce3f7e165cc2388b3dbece7dd7`.
- [ofl/fraunces/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/fraunces/METADATA.pb): 1197 bytes; SHA-256 `812aeaea90af8021a306b8fbb5490e0a861c27a5291d2253b403d9fc9f37afd5`.
- [ofl/fraunces/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/fraunces/OFL.txt): 4391 bytes; SHA-256 `bdf4c22802eaf804f998195871c6b8938aac2ac14b2d78a8bd66a6f1eced833b`.
- [ofl/googlesans/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/googlesans/METADATA.pb): 1437 bytes; SHA-256 `173d225cccaa76ed45cc03f47a268ecb2ae64b543daf8fe78c772930b4d529d5`.
- [ofl/googlesans/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/googlesans/OFL.txt): 4488 bytes; SHA-256 `2b75ef20f13d83a7514aee452c4782c20cdc9ff2dee17600f44d37a06d4fb958`.
- [ofl/googlesans/TRADEMARKS.md](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/googlesans/TRADEMARKS.md): 1470 bytes; SHA-256 `215bc8c1ce46d1b81531f33ebb5af201e7a5da76b8f3ae4c705336fd70fc89e1`.
- [ofl/inter/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/inter/METADATA.pb): 1342 bytes; SHA-256 `79e4721ef4f72251c6080a40dfd9efb6728b4df1fc690f0c70eb4b1b5303a5b0`.
- [ofl/inter/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/inter/OFL.txt): 4377 bytes; SHA-256 `5b9321a4298cfeb6b34354164a1c3afc3db114569984c502b9b35d988fd58c57`.
- [ofl/lato/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/lato/METADATA.pb): 10022 bytes; SHA-256 `b01e6d38725c22f991321800baf7a71af2dca3a381184eb80557c5308d5e34c5`.
- [ofl/lato/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/lato/OFL.txt): 4407 bytes; SHA-256 `74ba064d03f1f1c4a952da936c3eb71866c34404916734de3cae73b34357e59e`.
- [ofl/librebaskerville/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/librebaskerville/METADATA.pb): 1464 bytes; SHA-256 `e29f1dcebfdf5918d29c4d373e1a6a0ae3bcb94538aa63362fdcc7bf095cc9c8`.
- [ofl/librebaskerville/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/librebaskerville/OFL.txt): 4542 bytes; SHA-256 `3624eddd4c8f8a908130a417ae7cd089c9da69899c4e0ca1a5217d0a6fae16fd`.
- [ofl/lora/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/lora/METADATA.pb): 1349 bytes; SHA-256 `6d9e38cc8926e903359a1c4c358fd2e71864f422aae9550d0d9a2ae0c62ddb8d`.
- [ofl/lora/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/lora/OFL.txt): 4423 bytes; SHA-256 `1d9a970809ac804b582a6ce7f0ebc4e7fefcbfd7ff6299cad35ee656a21be716`.
- [ofl/merriweather/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/merriweather/METADATA.pb): 5391 bytes; SHA-256 `50aa12ab94b75275eb90b6353dd3f9b187c101ce0a89071f5456c052490a4345`.
- [ofl/merriweather/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/merriweather/OFL.txt): 4438 bytes; SHA-256 `715bd349bfa6116f99e351e1548321dcfa25b91df65502d22ca8d624557697d2`.
- [ofl/montserrat/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/montserrat/METADATA.pb): 6727 bytes; SHA-256 `c48dbcaee013b8f6a33e7e6a79191adbf098a36839367d9750598594ff664e5f`.
- [ofl/montserrat/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/montserrat/OFL.txt): 4400 bytes; SHA-256 `8b7141c03fa4f8d44e6345d5d4931709290f0f67875e452e95ac1fd3a027802e`.
- [ofl/newsreader/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/newsreader/METADATA.pb): 7076 bytes; SHA-256 `dc0bcb264c09d663c9a4f559e4f5392fd7d9f62139ad9cbba39253ec43aa315b`.
- [ofl/newsreader/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/newsreader/OFL.txt): 4394 bytes; SHA-256 `fdfad38143ec470553cae82a1e45320bdd1b9ec70415d37bd0171051d8a4ded8`.
- [ofl/notosans/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/notosans/METADATA.pb): 32340 bytes; SHA-256 `9fd9566184e9833ae3a33b8950e2782a8abb1f0a9d6fb2c51b3fb615f2d78cfe`.
- [ofl/notosans/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/notosans/OFL.txt): 4396 bytes; SHA-256 `cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a`.
- [ofl/notoserif/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/notoserif/METADATA.pb): 29397 bytes; SHA-256 `659cf6a2475eabfa3e3bbb92e3ed15c604e6fb035b3b1057d469cc88e67357bb`.
- [ofl/notoserif/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/notoserif/OFL.txt): 4396 bytes; SHA-256 `cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a`.
- [ofl/nunito/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/nunito/METADATA.pb): 1306 bytes; SHA-256 `3e20743c7ddab54c6ac57d79a6be522d4bae795223855ce90a1b13c4132f0754`.
- [ofl/nunito/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/nunito/OFL.txt): 4385 bytes; SHA-256 `580df76c95a1ec5ab878ceb25bb3d85c6a076804e9c970c8c6972aea775fdf65`.
- [ofl/nunitosans/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/nunitosans/METADATA.pb): 1758 bytes; SHA-256 `b60c93a2cdadb477316d22d22c8d43fa957899a4e4fe75cbb2b9e39e03c5e96e`.
- [ofl/nunitosans/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/nunitosans/OFL.txt): 4393 bytes; SHA-256 `efbb0c9e864cef973982d9a17567e6be5c3d1759695574586f3f18c7ecca064b`.
- [ofl/opensans/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/opensans/METADATA.pb): 5184 bytes; SHA-256 `50305d75a1b32bc4b5f59a037a71b0db45be509479519f7fded5b9cfa86217e8`.
- [ofl/opensans/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/opensans/OFL.txt): 4389 bytes; SHA-256 `fbbbcfef55318de350562559b671360de6d597112ecc5c73881b05092db89602`.
- [ofl/playfairdisplay/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/playfairdisplay/METADATA.pb): 1202 bytes; SHA-256 `c9e6a996754f710fb7ff2ba36f8dd807244318d561d63d247a22199ea1a5e94a`.
- [ofl/playfairdisplay/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/playfairdisplay/OFL.txt): 4449 bytes; SHA-256 `566be814f8e96e93dfa16101331557eb6b5467e9e03f627c0910fe93ca12300e`.
- [ofl/poppins/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/poppins/METADATA.pb): 5157 bytes; SHA-256 `8121646e47a90cbcd2f4664e0df036944880035522b4f25ec51cb9465428b346`.
- [ofl/poppins/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/poppins/OFL.txt): 4385 bytes; SHA-256 `6be04893d770899a015649c7aa3b582f871b272f8747a92b78b17c3e5c8b2573`.
- [ofl/ptserif/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ptserif/METADATA.pb): 1366 bytes; SHA-256 `a943b85eed1c2d368aaaa3e3999fbe8b15365153aa62889f76271bc10d1094ca`.
- [ofl/ptserif/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/ptserif/OFL.txt): 4434 bytes; SHA-256 `ddf311c28ddf5a5ad9747649837346b67bed9d356789c3072bb27dbce49e514d`.
- [ofl/raleway/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/raleway/METADATA.pb): 1013 bytes; SHA-256 `206017b9829b8f0a9aa3d2af2e8118520d8bff4930b4c834a52f057fc5965c9f`.
- [ofl/raleway/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/raleway/OFL.txt): 4497 bytes; SHA-256 `7e946cf1171784d1015279e7dc35f827957a6b5d1f1f659ae0c98e5f5e37ed9b`.
- [ofl/roboto/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/roboto/METADATA.pb): 1463 bytes; SHA-256 `6fef19da54fb62d152f0c7b21710e6849950db7ecf852ea29511c593dad462f0`.
- [ofl/roboto/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/roboto/OFL.txt): 4394 bytes; SHA-256 `061402327a96aadb0bfb694a960ed289ecd38d383e396243831ab81feb109c41`.
- [ofl/robotocondensed/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/robotocondensed/METADATA.pb): 1387 bytes; SHA-256 `2661545ea47047600f634d2b2485b9794758c1088b2dac15024ebc6c20fc1f47`.
- [ofl/robotocondensed/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/robotocondensed/OFL.txt): 4393 bytes; SHA-256 `0e4cc6ece88573545be2ed25835363662a6182ba4a4c1b5c8feda52add30e8a6`.
- [ofl/rubik/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/rubik/METADATA.pb): 1310 bytes; SHA-256 `2e81cc9a038e89bcf9a14cd4e2d4513c1b5959e8b9189b835d4ecf4af11968a6`.
- [ofl/rubik/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/rubik/OFL.txt): 4384 bytes; SHA-256 `472cbe7c25441df63e9c7864b43eb3c0f4b3df950c66a76224e6cfe1eae843fb`.
- [ofl/sourceserif4/METADATA.pb](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/sourceserif4/METADATA.pb): 1132 bytes; SHA-256 `f7b88902c1d2f41839a3f7bf6723d1e64044c7c183b82871ce770a95f24b84e3`.
- [ofl/sourceserif4/OFL.txt](https://raw.githubusercontent.com/google/fonts/9710da1eacb3be272583c3224dcb70f9da6eadbb/ofl/sourceserif4/OFL.txt): 4400 bytes; SHA-256 `5f94c3fd3a23131a417ab5a0c8452de57e70c3cfb9f604d88241f7065ebf9fd9`.
