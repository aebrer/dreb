# OpenDyslexic — bundled self-hosted web font

These WOFF2 files back the **explicit OpenDyslexic** browser-local font
selection (see `../../styles/themes.css`). OpenDyslexic is a dyslexia-friendly
family and is offered as a *bundled* alternative to the Google-hosted IBM Plex
Mono and the self-hosted JetBrains Mono. It is used only when
`data-font="opendyslexic"` is active (an explicit picker choice — never a theme
default), and is fetched lazily by the browser only then. Theme default keeps
Gruvbox on JetBrains Mono and the other themes on IBM Plex Mono; an explicit
choice overrides any theme.

## Source

- **Font:** OpenDyslexic
- **Upstream:** https://github.com/antijingoist/opendyslexic
- **Pinned revision:** tag `v0.91.12` → commit
  `449a41bbc25f7363c540ad112dfcef2f7b340c0a` (2019-10-17, "fixes for rc2")
- **Files used from that revision:**
  - `compiled/OpenDyslexic-Regular.woff2` → `opendyslexic-regular.woff2`
  - `compiled/OpenDyslexic-Italic.woff2` → `opendyslexic-italic.woff2`
  - `compiled/OpenDyslexic-Bold.woff2` → `opendyslexic-bold.woff2`
  - `compiled/OpenDyslexic-Bold-Italic.woff2` → `opendyslexic-bold-italic.woff2`
- **Exact source URLs:**
  - https://raw.githubusercontent.com/antijingoist/opendyslexic/449a41bbc25f7363c540ad112dfcef2f7b340c0a/compiled/OpenDyslexic-Regular.woff2
  - https://raw.githubusercontent.com/antijingoist/opendyslexic/449a41bbc25f7363c540ad112dfcef2f7b340c0a/compiled/OpenDyslexic-Italic.woff2
  - https://raw.githubusercontent.com/antijingoist/opendyslexic/449a41bbc25f7363c540ad112dfcef2f7b340c0a/compiled/OpenDyslexic-Bold.woff2
  - https://raw.githubusercontent.com/antijingoist/opendyslexic/449a41bbc25f7363c540ad112dfcef2f7b340c0a/compiled/OpenDyslexic-Bold-Italic.woff2

## Checksums (SHA-256, of the bundled binaries)

```
f007004af3cda5d8076e57c943f8cc8d00a0da25988b1ae1048683d60e7cac1a  opendyslexic-regular.woff2
eb6a1bacf7e7c87a08116af4cd00a82064fbe61647b9a0d4d70a339890268f88  opendyslexic-italic.woff2
dd9fa9c7991113b0dddefe9506a30ad26b48e302b7a8fb91719a4726e8fde85b  opendyslexic-bold.woff2
a20d82c2a1a0a6ab74796529aca31bfbae93e3e58f5a7360cba854dd98a15214  opendyslexic-bold-italic.woff2
```

## Processing

The binaries are used **unmodified** — only the file names changed. Unlike the
JetBrains Mono files above (which were subset and re-encoded), no subsetting or
re-encoding was applied here: subsetting would raise Reserved Font Name
concerns under the OFL, while keeping the upstream WOFF2 files verbatim avoids
them and still gives fully local, lazy browser loading (~112–120 KB per face,
fetched only when OpenDyslexic is selected).

The upstream name table reports `Version 0.920` at this tag (the tag is named
`v0.91.12`; the pin above is authoritative).

## Face and weight mapping

Upstream ships four static faces; the dashboard declares them with non-overlapping
weight ranges so no weight synthesizes a fake face:

| Bundled file | Upstream face (weight class) | `@font-face` range |
|---|---|---|
| `opendyslexic-regular.woff2` | Regular (400) | `100 499` |
| `opendyslexic-italic.woff2` | Italic (400) | `100 499` |
| `opendyslexic-bold.woff2` | Bold (800) | `500 900` |
| `opendyslexic-bold-italic.woff2` | Bold Italic (800) | `500 900` |

The dashboard's emphasized weights (500–800) therefore resolve to the real
upstream bold faces rather than faux-bold synthesis.

## Glyph coverage

The family covers Latin text, all coding punctuation the dashboard uses, the
status-chip glyphs `●` and `○`, and common typographic characters (dashes,
quotes, ellipsis, arrows). The remaining status glyphs `◆`, `✕`, and the
connection indicator `↻` are **not** in this family; they render through the
`"IBM Plex Mono", "Courier New", monospace` fallback of the
`data-font="opendyslexic"` stack — the same path an IBM-theme default already
uses for them (the Google-hosted IBM Plex Mono slices do not include those
geometric shapes either).

## License

SIL Open Font License 1.1 — see `OPENDYSLEXIC-OFL.txt` (copied verbatim from the
pinned revision). Copyright (c) 2019-07-29 Abbie Gonzalez, with Reserved Font
Name OpenDyslexic.
