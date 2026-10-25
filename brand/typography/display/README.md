# KoBOLD Display v2 (source package)

A source-buildable custom display serif made from the KoBOLD lettering concept. Intended for brand headings, the **KoBOLD** name, and **The Kobold's Tunnel** title, not long passages of text.

## What changed from v1

- Traces glyph silhouettes from the *alpha channel* of the source sheet. The v1 build mistakenly discarded dark portions of the artwork, causing visible gaps and broken lettering.
- Uses a common conversion scale for capitals, lowercase and numerals, preserving the proportions in the design sketch.
- Cleaner contours, fewer stray fragments, more consistent baselines and side bearings.
- Kerning feature for common display pairs, including `AV`, `To`, `Ta`, `Yo`, `LT` and others.
- Complete printable ASCII coverage, plus typographic quotation marks, en and em dashes, ellipsis, bullet and degree symbol.
- The optional **leaf O** is a stylistic alternate (`ss01`) for the KoBOLD wordmark, preserving a plain capital O elsewhere.

## Files

- `build_kobold_display_v2.py`: reproducible build code for OpenType TrueType and WOFF2 output.
- `export_kobold_v2_vectors.py`: exports source-derived glyph SVGs and editable outlined wordmarks.
- `forest_green_serif_typeface_specimen.png`: original source lettering sheet for the trace.
- `KoBOLDDisplay-v2-Specimen.png`: representative typography preview.
- `KoBOLDDisplay-v1-v2-Comparison.png`: visual before/after comparison.
- `KoBOLD-v2-Editable-Wordmark.svg`: stylised, two-colour brand name with the leaf-O alternate.
- `The-Kobolds-Tunnel-v2-Editable-Wordmark.svg`: title art using the v2 outlines.
- `vector-outlines/`: individual editable glyph graphics (SVG, not a font).
- `glyph_metrics.json`: dimensions and documented kerning pairs.

## Build locally

Install dependencies listed in `requirements.txt`, then run:

```bash
python3 build_kobold_display_v2.py
python3 export_kobold_v2_vectors.py
```

The builder writes locally generated TrueType (`.ttf`) and WOFF2 (`.woff2`) output into `KoBOLD_Display_v2/`. These binaries are intentionally **not included in this source package**.

To enable the alternate leaf-shaped O in a logo, use the OpenType stylistic set:

```css
.kobold-logo {
  font-family: 'KoBOLD Display', serif;
  font-feature-settings: 'ss01' 1;
}
```

Do not use `ss01` globally for body text. The alternate is intended for the primary nameplate only. Style the first two characters forest green and the remaining letters amber if reproducing the two-colour wordmark.

## Quality and limitations

This is a substantially improved **working display prototype**, not yet a finished commercial typeface. Vector edges and manual punctuation deserve further hand-tuning. Its glyph coverage is English-oriented and does not yet provide a full accented-Latin repertoire, ligature system, italic face or multiple weights. Rendering and kerning should be checked in the production browser stack before release.

The colour treatment belongs to the logo / CSS / SVG; the font itself is monochrome. No font file can reproduce the full illustration's textures, gradients, shadows or bespoke ornamental layout.

Brand specification for KoBOLD, prepared for **Prajwal Bhattaram**.
