# Iosevka — bundled self-hosted web font

These WOFF2 files back the **explicit Iosevka** browser-local font selection
(see `../../styles/themes.css`). Iosevka is a compact monospace family with a
high density of glyphs per line and default-on coding ligatures (via the
`calt` feature), offered as a *bundled* alternative to the Google-hosted IBM
Plex Mono and the other self-hosted families. It is used only when
`data-font="iosevka"` is active (an explicit picker choice — never a theme
default), and is fetched lazily by the browser only then. Theme default keeps
Gruvbox on JetBrains Mono and the other themes on IBM Plex Mono; an explicit
choice overrides any theme.

## Source

- **Font:** Iosevka
- **Upstream:** https://github.com/be5invis/Iosevka
- **Pinned revision:** tag `v34.8.1` (release published 2026-08-22)
- **Distribution artifact:** the static unhinted TTFs are published only in
  the release asset `PkgTTF-Unhinted-Iosevka-34.8.1.zip`:
  - https://github.com/be5invis/Iosevka/releases/download/v34.8.1/PkgTTF-Unhinted-Iosevka-34.8.1.zip
  - asset SHA-256: `267d4e39df444adee2bb77458a9a5c425be0fd288b20acaf81a2f591e0479ef2`
- **Files used from that artifact:**
  - `Iosevka-Regular.ttf` → `iosevka-regular.woff2`
  - `Iosevka-Medium.ttf` → `iosevka-medium.woff2`
  - `Iosevka-SemiBold.ttf` → `iosevka-semibold.woff2`
  - `Iosevka-Italic.ttf` → `iosevka-italic.woff2`
- **Input TTF SHA-256:**
  ```
  ffe99cc158208ae1cb62ff04b8d2848986a6d822e1e71ba04885c417e36fae3d  Iosevka-Regular.ttf
  dc298e970cacf7eb8f1c8ace05ba471cd56901aa7c1c878573519f35ce73f164  Iosevka-Medium.ttf
  21392d82136feca194e917a4f465a8d092ce55777246d44982918d194966dedf  Iosevka-SemiBold.ttf
  01f70966dcb3cfa141b50a5e32faee8a207e7b17bf2e3f04e59402aa537f43f9  Iosevka-Italic.ttf
  ```
- **License file:** `https://raw.githubusercontent.com/be5invis/Iosevka/v34.8.1/LICENSE.md`
  (bundled verbatim as `IOSEVKA-OFL.txt`)

## Checksums (SHA-256, of the bundled binaries)

```
e57cd5636d700742e4c24b39b5afcbcff77b2db013c7e1e97c7192c717679134  iosevka-regular.woff2
2ffc040ce1cae884bb8e55ff19e5589347165c3027151297996776af24a01763  iosevka-medium.woff2
ce2a7c1c7da5ea57be3672adf0e96088fa57d87be1383811f435ffa1a4bd60c1  iosevka-semibold.woff2
d96490ac2495e0cbeff22c168830e5073817d131d45e4788a31b1c29615f211d  iosevka-italic.woff2
```

## Processing

The upstream release ships full-coverage unhinted TTFs (≈7.7 MB each;
≈1.1 MB per WOFF2 after lossless conversion), far larger than the dashboard
needs. Each face was therefore **subset and re-encoded to WOFF2** with
fonttools 4.63.0 (`pyftsubset` + `fonttools ttLib.woff2 compress`), the same
pattern as the JetBrains Mono files. Subsetting is unrestricted under this
family's OFL (no Reserved Font Name).

Unicode ranges retained:

```
U+0020-007E  Basic Latin          U+2200-22FF  Mathematical Operators
U+00A0-00FF  Latin-1 Supplement   U+2300-23FF  Miscellaneous Technical
U+0100-024F  Latin Extended A/B   U+2460-24FF  Enclosed Alphanumerics
U+0250-02AF  IPA Extensions       U+25A0-25FF  Geometric Shapes (● ○ ◆)
U+0370-03FF  Greek                U+2600-26FF  Miscellaneous Symbols
U+0400-04FF  Cyrillic             U+2700-27BF  Dingbats (✕)
U+2000-206F  General Punctuation  U+2B00-2BFF  Misc. Symbols & Arrows
U+2070-209F  Super/Subscripts     U+FB00-FB06  Latin Ligatures
U+20A0-20CF  Currency             U+FE13-FE16, U+FEFF
U+2100-218F  Letterlike/Number Forms
U+2190-21FF  Arrows (↻)
```

Layout features retained: `calt`, `ccmp`, `dlig`, `zero` (coding ligatures
and the slashed-zero option); the family's ~100 stylistic
`cvNN`/vertical-writing features were pruned. Verified post-subset: every
range above resolves, and the dashboard status glyphs ● (U+25CF) ◆ (U+25C6) ○
(U+25CB) ✕ (U+2715) ↻ (U+21BB) are all present.

## Face and weight mapping

Upstream ships static faces; the dashboard declares them with exact single
weights matching the weights the dashboard CSS actually uses (400/500/600):

| Bundled file | Upstream face (weight class) | `@font-face` weight |
|---|---|---|
| `iosevka-regular.woff2` | Regular (400) | `400` |
| `iosevka-medium.woff2` | Medium (500) | `500` |
| `iosevka-semibold.woff2` | SemiBold (600) | `600` |
| `iosevka-italic.woff2` | Italic (400) | `400`, `font-style: italic` |

## Glyph coverage

Within the subset ranges above, coverage is complete (verified with fontTools
cmap analysis of the shipped binaries). Scripts outside the subset (CJK,
Hebrew, Arabic, …) resolve through the
`"IBM Plex Mono", "Courier New", monospace` fallback of the
`data-font="iosevka"` stack — the same path the other dashboard themes already
use for scripts the Google-hosted IBM Plex Mono slices lack.

## License

SIL Open Font License 1.1 — see `IOSEVKA-OFL.txt` (copied verbatim from the
pinned revision). Copyright (c) 2015-2026 Renzhi Li (aka. Belleve Invis).
