#!/usr/bin/env python3
"""Build local artwork and fonts. Does not touch release packages or download inputs."""

from pathlib import Path
import argparse
import hashlib
import json
import runpy
import shutil

from PIL import Image
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--font-source',
        type=Path,
        required=True,
        help='Directory containing the pinned upstream files in brand/typography/upstream.json',
    )
    args = parser.parse_args()
    upstream = json.loads((ROOT / 'brand/typography/upstream.json').read_text())
    for entry in upstream['files']:
        data = (args.font_source / entry['file']).read_bytes()
        if hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError('Upstream hash mismatch: ' + entry['file'])
    cache = ROOT / 'cache/ui-brand/build'
    cache.mkdir(parents=True, exist_ok=True)
    images = ROOT / 'web/assets/images'
    fonts = ROOT / 'web/assets/fonts'
    images.mkdir(parents=True, exist_ok=True)
    fonts.mkdir(parents=True, exist_ok=True)
    sources = ROOT / 'brand/source'
    hero = Image.open(
        sources / 'KoBOLD_Tunnel_Hero_Kobo_Libra_Colour_No_Text.png'
    ).convert('RGB')
    for width in (640, 1280, 1920):
        hero.resize(
            (width, round(hero.height * width / hero.width)), Image.Resampling.LANCZOS
        ).save(images / f'tunnel-{width}.webp', quality=84, method=6)
    for name, source in [
        ('banner', 'kobold-banner-hero.png'),
        ('network', 'Magical Secure Reading Passage.png'),
        ('install', 'Whimsical E-Reader Knowledge Tunnel.png'),
        ('emblem', 'kobold-logo-emblem.png'),
    ]:
        art = Image.open(sources / source).convert('RGB')
        for width in (320, 640) if name == 'emblem' else (640, 1280, 1920):
            art.resize(
                (width, round(art.height * width / art.width)), Image.Resampling.LANCZOS
            ).save(images / f'{name}-{width}.webp', quality=86, method=6)
    for index, name in enumerate(('your-kobo', 'tailscale', 'calibre-web'), 1):
        # Interior artwork only, excluding the supplied rounded frame and raster text.
        art = (
            Image.open(sources / 'cards' / f'0{index}-{name}-card.png')
            .convert('RGB')
            .crop((128, 120, 994, 928))
        )
        for width in (432, 866):
            art.resize(
                (width, round(art.height * width / art.width)), Image.Resampling.LANCZOS
            ).save(images / f'{name}-{width}.webp', quality=84, method=6)
    icon = Image.open(sources / 'kobold-app-icon.png').convert('RGB')
    for width in (96, 192):
        icon.resize((width, width), Image.Resampling.LANCZOS).save(
            images / f'app-icon-{width}.webp', quality=88, method=6
        )
    favicon = Image.open(sources / 'kobold-favicon-source.png').convert('RGB')
    for width in (32, 48, 180):
        favicon.resize((width, width), Image.Resampling.LANCZOS).save(
            images / f'favicon-{width}.png'
        )
    # Run the supplied builders from scratch space, without their optional Linux-only previews.
    shutil.copytree(
        ROOT / 'brand/typography/display', cache / 'display', dirs_exist_ok=True
    )
    display = runpy.run_path(str(cache / 'display/build_kobold_display_v2.py'))
    display['build'](cache / 'display/KoBOLD_Display_v2')
    story = runpy.run_path(
        str(ROOT / 'brand/typography/story/build_kobold_story_serif.py')
    )
    for style, weight in (('Regular', 400), ('Medium', 500)):
        original = TTFont(args.font_source / 'NotoSerifDisplay[wdth,wght].ttf')
        instance = instantiateVariableFont(
            original, {'wght': weight, 'wdth': 100}, inplace=True
        )
        static = cache / f'NotoSerifDisplay-{style}.ttf'
        instance.save(static)
        story['build'](static, style, cache)
    for source in (
        cache / 'display/KoBOLD_Display_v2/KoBOLDDisplay-v2-Regular.woff2',
        cache / 'KoBOLDStorySerif-Regular.woff2',
        cache / 'KoBOLDStorySerif-Medium.woff2',
    ):
        font = TTFont(source, recalcTimestamp=False)
        font['head'].created = font['head'].modified = 3875731200
        font.save(fonts / source.name)
    shutil.copy2(
        ROOT / 'brand/typography/OFL-NotoSerifDisplay.txt',
        fonts / 'OFL-NotoSerifDisplay.txt',
    )
    (fonts / 'README.txt').write_text(
        'KoBOLD Story Serif is adapted from Noto Serif Display, Copyright 2012 Google Inc.,\n'
        'under the SIL Open Font License 1.1. See OFL-NotoSerifDisplay.txt.\n'
        'KoBOLD Display v2: Copyright 2026 Prajwal Bhattaram. Supplied project artwork.\n'
        'Build sources, pinned inputs and hashes: brand/typography in the source repository.\n'
    )
    outputs = {
        str(p.relative_to(ROOT / 'web/assets')): hashlib.sha256(
            p.read_bytes()
        ).hexdigest()
        for p in sorted((ROOT / 'web/assets').rglob('*'))
        if p.is_file() and p.name != 'SHA256.json'
    }
    (ROOT / 'web/assets/SHA256.json').write_text(json.dumps(outputs, indent=2) + '\n')
    print('Prepared', len(outputs), 'local assets')


if __name__ == '__main__':
    main()
