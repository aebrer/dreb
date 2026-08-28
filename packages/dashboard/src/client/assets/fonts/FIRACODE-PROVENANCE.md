# Fira Code — bundled self-hosted web font

These WOFF2 files back the **explicit Fira Code** browser-local font selection
(see `../../styles/themes.css`). Fira Code is a monospace family known for its
default-on coding ligatures (`->`, `=>`, `!=`, …, via the `calt` feature) and
is offered as a *bundled* alternative to the Google-hosted IBM Plex Mono and
the other self-hosted families. It is used only when `data-font="fira-code"`
is active (an explicit picker choice — never a theme default), and is fetched
lazily by the browser only then. Theme default keeps Gruvbox on JetBrains Mono
and the other themes on IBM Plex Mono; an explicit choice overrides any theme.

## Source

- **Font:** Fira Code
- **Upstream:** https://github.com/tonsky/FiraCode
- **Pinned revision:** tag `6.2` (release `6.2`, published 2021-12-06)
- **Distribution artifact:** the font binaries are published only as the
  release asset `Fira_Code_v6.2.zip` (they are not in the tagged repo tree):
  - https://github.com/tonsky/FiraCode/releases/download/6.2/Fira_Code_v6.2.zip
  - asset SHA-256: `0949915ba8eb24d89fd93d10a7ff623f42830d7c5ffc3ecbf960e4ecad3e3e79`
- **Files used from that artifact:**
  - `ttf/FiraCode-Regular.ttf` → `fira-code-regular.woff2`
  - `ttf/FiraCode-Medium.ttf` → `fira-code-medium.woff2`
  - `ttf/FiraCode-SemiBold.ttf` → `fira-code-semibold.woff2`
- **Input TTF SHA-256:**
  ```
  5992ab9640e2df491b2f609467b1de60e8bc39b2c28db184342a0592d98f6117  ttf/FiraCode-Regular.ttf
  97091f90623661fb4f7979c10d188f30f4806d8ce326b0bc8d1acc79dcc20d8f  ttf/FiraCode-Medium.ttf
  500c74eec6249b06d49aef922dd3e8fc754c70c3b3f7791cd7b1a09ca9a26140  ttf/FiraCode-SemiBold.ttf
  ```
- **License file:** `https://raw.githubusercontent.com/tonsky/FiraCode/6.2/LICENSE`
  (bundled verbatim as `FIRACODE-OFL.txt`)

## Checksums (SHA-256, of the bundled binaries)

```
63699de93026d6571026178ebd82b2fd89c629686aaea949e601ee97a6f345f5  fira-code-regular.woff2
53b205e8c2f8cb60f3ffa1bd1304c2d5bd1962da2a789441f48b865e5fd0d55e  fira-code-medium.woff2
16a420c944d724b1421b69277b71d54660300c1f803e78f6b4612f05233a63bc  fira-code-semibold.woff2
```

## Processing

The upstream release ships TTFs only, so each face was **re-encoded to WOFF2**
with fonttools 4.63.0 (`fonttools ttLib.woff2 compress`), **without
subsetting** — the full glyph set is retained. Fira Code carries no Reserved
Font Name in its OFL, so re-encoding is unrestricted. Ligatures ship in the
`calt` feature, which browsers apply by default, so no `font-feature-settings`
is needed.

## Face and weight mapping

Upstream ships static faces; the dashboard declares them with exact single
weights matching the weights the dashboard CSS actually uses (400/500/600):

| Bundled file | Upstream face (weight class) | `@font-face` weight |
|---|---|---|
| `fira-code-regular.woff2` | Regular (400) | `400` |
| `fira-code-medium.woff2` | Medium (500) | `500` |
| `fira-code-semibold.woff2` | SemiBold (600) | `600` |

**No italic face exists upstream** — Fira Code has never shipped italics.
Italic text (e.g. `<em>` in transcripts) therefore renders as a synthesized
oblique of the regular face. This is an upstream limitation of the family, not
a processing choice; it only affects explicit Fira Code users.

## Glyph coverage

The full face covers Basic Latin, Latin-1, Latin Extended, Greek, Cyrillic,
general punctuation (curly quotes, dashes, ellipsis), super/subscripts,
currency, arrows (except ↵ U+21B5 and ↻ U+21BB), mathematical operators, and
geometric shapes (● ○ ■ □ ▲ ▼). The dashboard dingbat ✕ (U+2715) is **not** in
the face; missing glyphs resolve through the
`"IBM Plex Mono", "Courier New", monospace` fallback of the
`data-font="fira-code"` stack — the same path the other bundled families use
for their gaps.

## License

SIL Open Font License 1.1 — see `FIRACODE-OFL.txt` (copied verbatim from the
pinned revision). Copyright (c) 2014 The Fira Code Project Authors.
