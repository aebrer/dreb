# JetBrains Mono — self-hosted web font

These WOFF2 files back the **gruvbox** dashboard appearance theme (see
`../../styles/themes.css`). They are fetched by the browser only when gruvbox is
the active theme; the default, dim, and solarized themes use IBM Plex Mono.

## Source

- **Font:** JetBrains Mono (variable, `wght` axis)
- **Upstream:** https://github.com/JetBrains/JetBrainsMono
- **Release:** v2.304 —
  https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip
- **Files used from the release:**
  - `fonts/variable/JetBrainsMono[wght].ttf` → `jetbrains-mono.woff2`
  - `fonts/variable/JetBrainsMono-Italic[wght].ttf` → `jetbrains-mono-italic.woff2`

## Processing

The upstream variable TTFs were **subset and re-encoded to WOFF2** with
`fonttools` (`pyftsubset`). The glyph outlines are **unmodified**; only the
codepoint coverage was narrowed and the container converted TTF → WOFF2:

```
pyftsubset "JetBrainsMono[wght].ttf" \
  --output-file=jetbrains-mono.woff2 --flavor=woff2 \
  --unicodes="U+0000-00FF,U+0131,U+0152-0153,U+2000-206F,U+2070-209F,\
U+20A0-20BF,U+2100-214F,U+2190-21FF,U+2200-22FF,U+2500-257F,U+2580-259F,\
U+25A0-25FF,U+2700-27BF" \
  --layout-features='*' --glyph-names --no-hinting --desubroutinize
```

(The italic file uses the same command against `JetBrainsMono-Italic[wght].ttf`.)

The subset keeps Basic Latin + Latin-1, general/superscript punctuation,
currency, letterlike symbols, arrows, math operators, box drawing, block
elements, **geometric shapes**, and dingbats — enough to render every glyph the
dashboard uses, including the status-chip glyphs `●` `◆` `○` `✕`. Cyrillic,
Greek, and Vietnamese ranges were dropped to keep the payload small
(~64 KB normal / ~69 KB italic). The `wght` variable axis (100–800) is
preserved, so weights 400/500/600 render natively without faux-bold synthesis.

## License

SIL Open Font License 1.1 — see `OFL.txt` (copied verbatim from the release).
Copyright 2020 The JetBrains Mono Project Authors.
