#!/usr/bin/env python3
"""Build KoBOLD Story Serif, a Noto Serif Display-derived companion family.

Required: fonttools (fontTools), brotli for WOFF2.
Requires locally installed original SIL OFL fonts from the Noto Serif Display
family. Original font binaries are not redistributed in this package.

Uses intentionally restrained modifications so text stays legible:
- distinct family names, appropriate metadata
- refined letter spacing for display and explanatory headings
- original robust optical drawing and OpenType kerning retained
- original standard and typographic punctuation retained
- custom three-leaf KoBOLD ornament mapped to U+E000

Built files are saved to the output directory you choose.
"""

from __future__ import annotations
import argparse
import copy
import os
from pathlib import Path
import subprocess

from fontTools.ttLib import TTFont
from fontTools.pens.ttGlyphPen import TTGlyphPen

FAMILY = 'KoBOLD Story Serif'
SOURCE = 'Noto Serif Display'
SUGGESTED_PATHS = {
    'Regular': [
        '/usr/share/fonts/truetype/noto/NotoSerifDisplay-Regular.ttf',
        '/usr/local/share/fonts/NotoSerifDisplay-Regular.ttf',
        'NotoSerifDisplay-Regular.ttf',
    ],
    'Medium': [
        '/usr/share/fonts/truetype/noto/NotoSerifDisplay-Medium.ttf',
        '/usr/local/share/fonts/NotoSerifDisplay-Medium.ttf',
        'NotoSerifDisplay-Medium.ttf',
    ],
}


def find_source(style: str, explicit: str | None):
    if explicit and Path(explicit).is_file():
        return Path(explicit)
    for p in SUGGESTED_PATHS[style]:
        if Path(p).is_file():
            return Path(p)
    try:
        found = (
            subprocess.run(
                ['fc-match', '-f', '%{file}\\n', f'Noto Serif Display:style={style}'],
                text=True,
                capture_output=True,
                check=True,
            )
            .stdout.strip()
            .splitlines()[0]
        )
        if found and 'NotoSerifDisplay' in Path(found).name and Path(found).is_file():
            return Path(found)
    except (IndexError, FileNotFoundError, subprocess.SubprocessError):
        pass
    raise FileNotFoundError(
        f'Missing Noto Serif Display {style}. Install the SIL OFL source '
        f'and pass --{style.lower()} /path/to/font.ttf'
    )


def add_ornament(font: TTFont):
    """Three stylised leaves for the KoBOLD brand, Unicode Private Use E000."""
    if 'glyf' not in font or 'hmtx' not in font:
        raise TypeError('Expected a TrueType source with glyf outlines')
    name = 'kobold.threeLeaves'
    pen = TTGlyphPen(None)

    # Draw all closed shapes clockwise. Units relative to 1000-unit em.
    # The negative-space branches are separate pieces, suited to a tiny ornament.
    def leaf(points):
        pen.moveTo(points[0])
        for p in points[1:]:
            pen.qCurveTo(*p)
        pen.closePath()

    # Leaves laid out like a short sprig, matching the printed KoBOLD identity.
    pen.moveTo((344, 120))
    pen.qCurveTo((178, 190), (140, 350))
    pen.qCurveTo((260, 351), (340, 270))
    pen.qCurveTo((373, 210), (344, 120))
    pen.closePath()
    pen.moveTo((380, 170))
    pen.qCurveTo((310, 365), (392, 540))
    pen.qCurveTo((488, 433), (467, 294))
    pen.qCurveTo((442, 217), (380, 170))
    pen.closePath()
    pen.moveTo((418, 120))
    pen.qCurveTo((575, 177), (643, 340))
    pen.qCurveTo((531, 355), (437, 258))
    pen.qCurveTo((402, 196), (418, 120))
    pen.closePath()
    # Narrow little trunk
    pen.moveTo((380, 78))
    pen.lineTo((404, 78))
    pen.lineTo((404, 220))
    pen.lineTo((380, 220))
    pen.closePath()

    font['glyf'][name] = pen.glyph()
    glyph_order = font.getGlyphOrder()
    if name not in glyph_order:
        glyph_order.append(name)
        font.setGlyphOrder(glyph_order)
    font['hmtx'].metrics[name] = (790, 0)
    for table in font['cmap'].tables:
        if table.isUnicode():
            table.cmap[0xE000] = name
    font['maxp'].numGlyphs = len(font.getGlyphOrder())


def update_names(font: TTFont, style: str):
    for name_id, value in [
        (1, FAMILY),
        (2, style),
        (3, f'KoBOLD Story Serif {style} Version 1.0'),
        (4, f'{FAMILY} {style}'),
        (5, 'Version 1.0'),
        (6, f'KoBOLDStorySerif-{style}'),
        (16, FAMILY),
        (17, style),
        (8, 'KoBOLD typography, adapted from Noto Serif Display'),
        (9, 'Google LLC (Noto source); adaptation for Prajwal Bhattaram'),
        (13, 'SIL Open Font License 1.1'),
        (14, 'https://openfontlicense.org'),
    ]:
        font['name'].setName(value, name_id, 3, 1, 0x409)
        font['name'].setName(value, name_id, 1, 0, 0)
    if 'OS/2' in font:
        font['OS/2'].usWeightClass = 400 if style == 'Regular' else 500
    if 'head' in font:
        font['head'].macStyle = 0


def adjust_metrics(font: TTFont):
    # Very light tracking for a calm literary feel: +16 units spread across sides.
    # We leave original contours, OpenType kerning and ligatures intact.
    cmap = font.getBestCmap()
    metrics = font['hmtx'].metrics
    ignored = {' ', '\u00a0', '\u2009'}
    codepoints = [*range(0x21, 0x7F), *range(0xA1, 0x180)]
    seen = set()
    for codepoint in codepoints:
        if chr(codepoint) in ignored:
            continue
        gn = cmap.get(codepoint)
        if not gn or gn in seen or gn not in metrics:
            continue
        seen.add(gn)
        w, lsb = metrics[gn]
        metrics[gn] = (w + 12, lsb + 6)
        # The glyf contour itself is unchanged. Only metrics are modified.
    # Also nudge word spaces for readability at small explanatory sizes.
    space = cmap.get(32)
    if space and space in metrics:
        w, lsb = metrics[space]
        metrics[space] = (w + 10, lsb)


def build(source: Path, style: str, outdir: Path):
    font = TTFont(source)
    if 'glyf' not in font:
        raise TypeError(f'{source}: source must have TrueType outlines')
    update_names(font, style)
    adjust_metrics(font)
    add_ornament(font)
    # Output to local folder. Distribute only if permitted by your environment.
    outdir.mkdir(parents=True, exist_ok=True)
    stem = f'KoBOLDStorySerif-{style}'
    ttf = outdir / f'{stem}.ttf'
    font.flavor = None
    font.save(ttf)
    print('Built', ttf)
    try:
        woff = outdir / f'{stem}.woff2'
        webfont = TTFont(ttf)
        webfont.flavor = 'woff2'
        webfont.save(woff)
        print('Built', woff)
    except Exception as exc:
        print('WOFF2 was unavailable:', exc)
    font.close()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--regular', help='Path to SIL OFL NotoSerifDisplay-Regular.ttf')
    p.add_argument('--medium', help='Path to SIL OFL NotoSerifDisplay-Medium.ttf')
    p.add_argument('--output', default='./built-fonts', help='Output directory')
    args = p.parse_args()
    out = Path(args.output)
    for style in ('Regular', 'Medium'):
        src = find_source(style, getattr(args, style.lower()))
        print(f'Using source for {style}: {src}')
        build(src, style, out)


if __name__ == '__main__':
    main()
