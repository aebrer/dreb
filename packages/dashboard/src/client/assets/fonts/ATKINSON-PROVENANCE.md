# Atkinson Hyperlegible — bundled self-hosted web font

These WOFF2 files back the **explicit Atkinson Hyperlegible** browser-local
font selection (see `../../styles/themes.css`). Atkinson Hyperlegible is a
sans-serif family designed for readers with low vision or dyslexia (distinct
letterforms, open apertures, consistent stroke widths) and is offered as a
*second bundled accessibility alternative* alongside OpenDyslexic. It is used
only when `data-font="atkinson-hyperlegible"` is active (an explicit picker
choice — never a theme default), and is fetched lazily by the browser only
then. Theme default keeps Gruvbox on JetBrains Mono and the other themes on
IBM Plex Mono; an explicit choice overrides any theme.

## Source

- **Font:** Atkinson Hyperlegible (Next, v2.001 — the 2024 second-generation
  official version; the picker label is "Atkinson Hyperlegible")
- **Upstream:** https://github.com/googlefonts/atkinson-hyperlegible-next
- **Pinned revision:** commit `7925f50f649b3813257faf2f4c0b381011f434f1`
  (2025-02-21, "Fix Cairo in CI" — tip of `main`; the repo publishes no
  release tags)
- **Files used at that revision (unmodified):**
  - `fonts/webfonts/AtkinsonHyperlegibleNext-Regular.woff2` → `atkinson-hyperlegible-regular.woff2`
  - `fonts/webfonts/AtkinsonHyperlegibleNext-Medium.woff2` → `atkinson-hyperlegible-medium.woff2`
  - `fonts/webfonts/AtkinsonHyperlegibleNext-SemiBold.woff2` → `atkinson-hyperlegible-semibold.woff2`
  - `fonts/webfonts/AtkinsonHyperlegibleNext-Italic.woff2` → `atkinson-hyperlegible-italic.woff2`
- **Exact source URLs:**
  - https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/7925f50f649b3813257faf2f4c0b381011f434f1/fonts/webfonts/AtkinsonHyperlegibleNext-Regular.woff2
  - https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/7925f50f649b3813257faf2f4c0b381011f434f1/fonts/webfonts/AtkinsonHyperlegibleNext-Medium.woff2
  - https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/7925f50f649b3813257faf2f4c0b381011f434f1/fonts/webfonts/AtkinsonHyperlegibleNext-SemiBold.woff2
  - https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/7925f50f649b3813257faf2f4c0b381011f434f1/fonts/webfonts/AtkinsonHyperlegibleNext-Italic.woff2
- **License file:** `https://raw.githubusercontent.com/googlefonts/atkinson-hyperlegible-next/7925f50f649b3813257faf2f4c0b381011f434f1/OFL.txt`
  (bundled verbatim as `ATKINSON-OFL.txt`)

## Checksums (SHA-256, of the bundled binaries)

```
378aea0f5c1d179f4e0b5382c06bfc87571b98cfcc4fd1352bc979e2e2259c54  atkinson-hyperlegible-regular.woff2
bfc725eb446c7f1fb5671e42ee95f2ca7380e81edefcbf0ae725f9287c96613b  atkinson-hyperlegible-medium.woff2
4ab00275cc496a478fce7baafe89ed44af875acf57655dfd1183ff22bd23829a  atkinson-hyperlegible-semibold.woff2
97f9cffe4912f3ceaa41583dca26ae4874b4847243a826c87203071d8ad601ad  atkinson-hyperlegible-italic.woff2
```

## Processing

The upstream repo ships ready-to-serve WOFF2 webfonts, so the binaries are
used **unmodified** — only the file names changed (dropping the `Next`
suffix). No subsetting or re-encoding was applied. The family is small
(≈25 KB per face) by design, so no size-driven subsetting was considered.

The upstream name table reports per-weight family names (e.g.
"Atkinson Hyperlegible Next Medium"); the dashboard's `@font-face` rules
deliberately declare a single `font-family: "Atkinson Hyperlegible Next"` so
the four faces form one family.

## Face and weight mapping

Upstream ships static faces (the pinned revision also has a variable font,
which the dashboard does not use); the dashboard declares the four faces with
exact single weights matching the weights the dashboard CSS actually uses
(400/500/600):

| Bundled file | Upstream face (weight class) | `@font-face` weight |
|---|---|---|
| `atkinson-hyperlegible-regular.woff2` | Regular (400) | `400` |
| `atkinson-hyperlegible-medium.woff2` | Medium (500) | `500` |
| `atkinson-hyperlegible-semibold.woff2` | SemiBold (600) | `600` |
| `atkinson-hyperlegible-italic.woff2` | Italic (400) | `400`, `font-style: italic` |

## Glyph coverage

The family is Latin-centric by design (verified with fontTools cmap analysis
of the shipped binaries): Basic Latin, Latin-1, Latin Extended, currency,
mathematical operators (± × ÷ ≤ ≥ ≠), and general punctuation (curly quotes,
dashes, ellipsis) are present. Greek, Cyrillic, arrows (including ↻ U+21BB),
the geometric status shapes (● ◆ ○ U+25CF/U+25C6/U+25CB), and dingbats
(including ✕ U+2715) are **not** in the faces; they resolve through the
`"IBM Plex Mono", "Courier New", monospace` fallback of the
`data-font="atkinson-hyperlegible"` stack — the same path the other bundled
families use for their gaps. The family's intent is legible Latin text, and
the status-chip glyphs render from the fallback face without layout impact.

## License

SIL Open Font License 1.1 — see `ATKINSON-OFL.txt` (copied verbatim from the
pinned revision). Copyright 2020-2024 The Atkinson Hyperlegible Next Project
Authors.
