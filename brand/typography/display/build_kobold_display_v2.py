"""KoBOLD Display v2 source builder.

Builds a monochrome display face by retracing the alpha channel of the original
KoBOLD concept glyph specimen, cleaning and regularising outlines, standardising
metrics, adding new vector punctuation, and adding commonly used kerning pairs.

Dependencies: numpy, Pillow, opencv-python, fontTools, scipy.
Run: python3 build_kobold_display_v2.py
The generated font files are for local QA / build only.
"""

from __future__ import annotations
import json, math
from pathlib import Path
from collections import OrderedDict

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import gaussian_filter
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.agl import UV2AGL
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent
SPECIMEN = ROOT / 'forest_green_serif_typeface_specimen.png'
OUT = ROOT / 'KoBOLD_Display_v2'
OUT.mkdir(exist_ok=True)
UPM = 1000
# Same conversion for ALL glyphs preserves the original cap / x-height relationship.
SCALE = 5.73
ASCENDER = 830
DESCENDER = -225
SIDE_BEARING = 28
# Coordinates were taken from the concept sheet (x0,y0,x1,y1), with y origin at bottom.
ROWS = [
    (
        'ABCDEFGHIJKLM',
        864,
        [
            (55, 864, 186, 983),
            (192, 864, 288, 981),
            (292, 864, 386, 980),
            (391, 863, 502, 982),
            (507, 862, 599, 982),
            (603, 864, 685, 983),
            (688, 862, 793, 981),
            (797, 864, 905, 982),
            (918, 864, 967, 982),
            (967, 844, 1037, 982),
            (1048, 863, 1166, 982),
            (1172, 862, 1260, 982),
            (1259, 864, 1399, 982),
        ],
    ),
    (
        'NOPQRSTUVWXYZ',
        710,
        [
            (41, 711, 157, 829),
            (153, 709, 257, 824),
            (258, 711, 352, 829),
            (354, 678, 470, 824),
            (464, 710, 579, 829),
            (577, 709, 666, 827),
            (663, 711, 755, 829),
            (757, 710, 858, 829),
            (860, 709, 969, 829),
            (970, 709, 1121, 829),
            (1113, 711, 1233, 828),
            (1229, 711, 1330, 828),
            (1324, 709, 1420, 829),
        ],
    ),
    (
        'abcdefghijklm',
        540,
        [
            (82, 538, 180, 632),
            (185, 538, 294, 678),
            (308, 539, 396, 632),
            (406, 538, 507, 675),
            (515, 539, 602, 632),
            (614, 540, 691, 676),
            (686, 499, 786, 646),
            (797, 540, 903, 677),
            (914, 540, 966, 670),
            (957, 504, 1022, 677),
            (1041, 539, 1149, 677),
            (1156, 540, 1209, 677),
            (1218, 540, 1371, 632),
        ],
    ),
    (
        'nopqrstuvwxyz',
        385,
        [
            (61, 386, 167, 475),
            (174, 384, 271, 476),
            (276, 346, 380, 478),
            (390, 337, 519, 478),
            (504, 386, 584, 477),
            (591, 384, 666, 476),
            (674, 384, 741, 495),
            (750, 384, 855, 476),
            (858, 385, 953, 474),
            (959, 384, 1087, 474),
            (1089, 386, 1191, 475),
            (1188, 339, 1269, 477),
            (1258, 383, 1387, 477),
        ],
    ),
    (
        '0123456789',
        196,
        [
            (227, 196, 324, 315),
            (337, 197, 396, 315),
            (412, 196, 503, 315),
            (514, 196, 602, 316),
            (615, 197, 714, 316),
            (728, 196, 813, 316),
            (828, 196, 917, 315),
            (933, 198, 1016, 314),
            (1024, 196, 1115, 316),
            (1130, 192, 1218, 313),
        ],
    ),
]


def glyph_name(ch: str) -> str:
    return UV2AGL.get(ord(ch), f'uni{ord(ch):04X}')


def polygon_pen(polygons: list[list[tuple[float, float]]], width=None):
    pen = TTGlyphPen(None)
    for pts in polygons:
        if len(pts) < 3:
            continue
        pen.moveTo(tuple(pts[0]))
        for p in pts[1:]:
            pen.lineTo(tuple(p))
        pen.closePath()
    return pen.glyph()


def signed_area(pts):
    return (
        sum(
            pts[i][0] * pts[(i + 1) % len(pts)][1]
            - pts[(i + 1) % len(pts)][0] * pts[i][1]
            for i in range(len(pts))
        )
        / 2
    )


def ring(cx, cy, r, n=24):
    return [
        (cx + math.cos(2 * math.pi * i / n) * r, cy + math.sin(2 * math.pi * i / n) * r)
        for i in range(n)
    ]


def simple_rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def correct_winding(points, clockwise):
    # TrueType: outer clockwise, inner counter-clockwise in y-up coordinates.
    if (signed_area(points) < 0) != clockwise:
        points = points[::-1]
    return points


def glyph_contours(
    binary, origin_x, origin_y, baseline, scale, desired_left=SIDE_BEARING
):
    """Convert a thresholded glyph crop to cleaned, reasonably smooth TT paths."""
    pen = TTGlyphPen(None)
    # Foreground element cleaning: suppress isolated one-pixel debris, but preserve dots.
    n, cc, stats, _ = cv2.connectedComponentsWithStats(binary.astype('uint8'), 8)
    clean = np.zeros_like(binary, dtype='uint8')
    for k in range(1, n):
        area = int(stats[k, cv2.CC_STAT_AREA])
        if area >= 9:
            clean[cc == k] = 255
    # Stable contours and nested interior counters.
    contours, hierarchy = cv2.findContours(
        clean, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE
    )
    if hierarchy is None:
        return pen.glyph(), (300, 0)
    # Find left/right occupied span, positioning glyph at optical side bearing.
    ys, xs = np.where(clean > 0)
    if not len(xs):
        return pen.glyph(), (300, 0)
    min_x = int(xs.min())
    max_x = int(xs.max())
    contour_count = 0
    for idx, c in enumerate(contours):
        area = abs(cv2.contourArea(c))
        if area < 5:
            continue
        # Low-epsilon contours reduce distortions seen in v1 (large-epsilon polygonisation).
        eps = 1.05
        approx = cv2.approxPolyDP(c, eps, True)[:, 0, :]
        if len(approx) < 3:
            continue
        points = []
        for px, py in approx:
            xx = (float(px) - min_x) * scale + desired_left
            yy = (origin_y - (int(py)) - baseline) * scale
            points.append((round(xx, 2), round(yy, 2)))
        if len(set(points)) < 3:
            continue
        parent = hierarchy[0][idx][3]
        depth = 0
        while parent != -1:
            depth += 1
            parent = hierarchy[0][parent][3]
        points = correct_winding(points, clockwise=(depth % 2 == 0))
        pen.moveTo(points[0])
        for p in points[1:]:
            pen.lineTo(p)
        pen.closePath()
        contour_count += 1
    width = int(round((max_x - min_x + 1) * scale + SIDE_BEARING * 2))
    return pen.glyph(), (width, SIDE_BEARING)


def construct_traced(image):
    rgba = np.array(image)
    alpha = rgba[:, :, 3].astype('float32')
    H, W = alpha.shape
    glyphs = {}
    metrics = {}
    diagnostics = {}
    for text, baseline, positions in ROWS:
        # Use known glyph positions to disambiguate crowded letter boundaries.
        # We do NOT include the adjacent glyph in the crop.
        for i, ch in enumerate(text):
            x0, y0, x1, y1 = positions[i]
            left = x0 - 3
            right = x1 + 3
            if i > 0:
                prev = positions[i - 1]
                cut = round((prev[2] + x0) / 2)
                # Find lowest alpha column close to between-char gap, where available.
                candidates = np.arange(
                    max(prev[2] - 6, cut - 6), min(x0 + 7, cut + 7) + 1
                )
                if len(candidates):
                    valid = candidates[(candidates >= 0) & (candidates < W)]
                    if len(valid):
                        activity = np.array(
                            [
                                alpha[H - y1 - 4 : H - y0 + 4, int(z)].sum()
                                for z in valid
                            ]
                        )
                        cut = int(valid[np.argmin(activity)])
                left = max(left, cut)
            if i < len(text) - 1:
                nxt = positions[i + 1]
                cut = round((x1 + nxt[0]) / 2)
                candidates = np.arange(
                    max(x1 - 7, cut - 6), min(nxt[0] + 7, cut + 7) + 1
                )
                if len(candidates):
                    valid = candidates[(candidates >= 0) & (candidates < W)]
                    if len(valid):
                        activity = np.array(
                            [
                                alpha[H - y1 - 4 : H - y0 + 4, int(z)].sum()
                                for z in valid
                            ]
                        )
                        cut = int(valid[np.argmin(activity)])
                right = min(right, cut)
            if right <= left + 6:
                left = x0
                right = x1
            top = max(0, H - y1 - 4)
            bottom = min(H, H - y0 + 4)
            raw = alpha[top:bottom, max(0, left) : min(W, right)]
            # Important improvement over v1: trace transparency, not dark RGB fill.
            sm = gaussian_filter(raw, sigma=0.5)
            binary = (sm > 105).astype('uint8') * 255
            g, m = glyph_contours(binary, left, H - top, baseline, SCALE)
            gn = glyph_name(ch)
            glyphs[gn] = g
            metrics[gn] = m
            diagnostics[ch] = dict(src=(left, top, right, bottom), width=m[0])
    return glyphs, metrics, diagnostics


def stroke_polygon_path(points, thick=52):
    """Use cv2-free vector geometry via shapely for simple stroked punctuation."""
    from shapely.geometry import LineString, MultiPolygon, Polygon

    geom = LineString(points).buffer(thick / 2, cap_style=2, join_style=2, resolution=8)
    if isinstance(geom, Polygon):
        parts = [geom]
    else:
        parts = list(geom.geoms)
    polygons = []
    for geom in parts:
        polygons.append(correct_winding(list(geom.exterior.coords)[:-1], True))
        for h in geom.interiors:
            polygons.append(correct_winding(list(h.coords)[:-1], False))
    return polygons


def manual_punctuation(ch):
    p = []
    w = 320
    if ch == ' ':
        return polygon_pen([]), (300, 0)
    elif ch == '.':
        p = [ring(135, 60, 43)]
        w = 275
    elif ch == ',':
        p = [ring(145, 66, 38), [(145, 70), (184, 65), (135, -85), (110, -80)]]
        w = 280
    elif ch == "'":
        p = [ring(122, 592, 32), [(115, 595), (150, 594), (110, 460), (96, 460)]]
        w = 225
    elif ch == '"':
        p = [
            ring(115, 592, 28),
            [(105, 595), (137, 590), (110, 478), (95, 478)],
            ring(254, 592, 28),
            [(248, 590), (275, 590), (248, 478), (232, 478)],
        ]
        w = 355
    elif ch == '-':
        p = [simple_rect(45, 255, 290, 311)]
        w = 338
    elif ch == '–':
        p = [simple_rect(42, 255, 450, 310)]
        w = 493
    elif ch == '—':
        p = [simple_rect(45, 255, 710, 310)]
        w = 755
    elif ch == '…':
        p = [ring(100, 64, 39), ring(260, 64, 39), ring(420, 64, 39)]
        w = 525
    elif ch == '•':
        p = [ring(155, 330, 73)]
        w = 310
    elif ch == '°':
        p = [
            correct_winding(ring(158, 587, 100), True),
            correct_winding(ring(158, 587, 52), False),
        ]
        w = 330
    elif ch == '_':
        p = [simple_rect(20, -114, 420, -57)]
        w = 440
    elif ch == ':':
        p = [ring(135, 360, 40), ring(135, 60, 40)]
        w = 275
    elif ch == ';':
        p = [
            ring(145, 360, 40),
            ring(145, 70, 40),
            [(145, 70), (178, 56), (130, -65), (112, -65)],
        ]
        w = 275
    elif ch == '!':
        p = [simple_rect(110, 185, 169, 700), ring(138, 64, 43)]
        w = 285
    elif ch == '’':
        p = [[(95, 545), (127, 633), (167, 635), (180, 591), (150, 510), (115, 473)]]
        w = 234
    elif ch == '‘':
        p = [[(175, 540), (141, 633), (101, 635), (93, 592), (124, 511), (157, 477)]]
        w = 234
    elif ch == '“':
        p = [
            [(170, 540), (136, 633), (96, 635), (88, 592), (119, 511), (152, 477)],
            [(318, 540), (284, 633), (244, 635), (236, 592), (267, 511), (300, 477)],
        ]
        w = 394
    elif ch == '”':
        p = [
            [(88, 545), (120, 633), (160, 635), (173, 591), (143, 510), (108, 473)],
            [(240, 545), (272, 633), (312, 635), (325, 591), (295, 510), (260, 473)],
        ]
        w = 394
    elif ch == '?':
        p = [
            ring(215, 65, 43),
            [
                (160, 620),
                (130, 600),
                (90, 615),
                (90, 690),
                (185, 725),
                (295, 706),
                (335, 640),
                (324, 560),
                (281, 513),
                (245, 459),
                (241, 255),
                (186, 255),
                (186, 466),
                (225, 524),
                (267, 580),
                (270, 636),
                (239, 668),
                (179, 657),
            ],
        ]
        w = 398
    elif ch == '(':
        p = stroke_polygon_path(
            [(224, 756), (172, 664), (143, 535), (130, 385), (149, 211), (225, -85)], 50
        )
        w = 302
    elif ch == ')':
        p = stroke_polygon_path(
            [(75, 756), (129, 664), (157, 535), (168, 385), (150, 211), (73, -85)], 50
        )
        w = 302
    elif ch == '[':
        p = [
            simple_rect(85, -76, 151, 754),
            simple_rect(85, 692, 274, 754),
            simple_rect(85, -76, 274, -14),
        ]
        w = 326
    elif ch == ']':
        p = [
            simple_rect(170, -76, 236, 754),
            simple_rect(47, 692, 236, 754),
            simple_rect(47, -76, 236, -14),
        ]
        w = 326
    elif ch == '{':
        p = stroke_polygon_path(
            [
                (265, 760),
                (181, 743),
                (155, 684),
                (163, 513),
                (125, 426),
                (65, 383),
                (125, 338),
                (165, 273),
                (156, 85),
                (185, 5),
                (265, -15),
            ],
            43,
        )
        w = 325
    elif ch == '}':
        p = stroke_polygon_path(
            [
                (65, 760),
                (149, 743),
                (175, 684),
                (167, 513),
                (205, 426),
                (265, 383),
                (205, 338),
                (165, 273),
                (174, 85),
                (145, 5),
                (65, -15),
            ],
            43,
        )
        w = 325
    elif ch == '/':
        p = stroke_polygon_path([(74, -105), (358, 760)], 60)
        w = 432
    elif ch == '\\':
        p = stroke_polygon_path([(70, 760), (355, -105)], 60)
        w = 432
    elif ch == '|':
        p = [simple_rect(135, -125, 192, 754)]
        w = 324
    elif ch == '+':
        p = [simple_rect(55, 295, 425, 345), simple_rect(210, 138, 270, 502)]
        w = 480
    elif ch == '=':
        p = [simple_rect(70, 355, 410, 415), simple_rect(70, 210, 410, 270)]
        w = 480
    elif ch == '<':
        p = stroke_polygon_path([(384, 520), (89, 320), (384, 120)], 60)
        w = 476
    elif ch == '>':
        p = stroke_polygon_path([(90, 520), (385, 320), (90, 120)], 60)
        w = 476
    elif ch == '*':
        for k in range(3):
            ang = k * math.pi / 3
            dx, dy = math.cos(ang) * 190, math.sin(ang) * 190
            p += stroke_polygon_path([(250 - dx, 495 - dy), (250 + dx, 495 + dy)], 43)
        w = 500
    elif ch == '#':
        p = [
            simple_rect(150, 20, 210, 705),
            simple_rect(320, 20, 380, 705),
            simple_rect(65, 220, 470, 278),
            simple_rect(65, 450, 470, 508),
        ]
        w = 530
    elif ch == '%':
        p = stroke_polygon_path([(75, 0), (530, 710)], 56)
        p += [ring(153, 585, 89), ring(438, 116, 89)]
        # avoid filling interior circles via handling holes
        p += [
            correct_winding(ring(153, 585, 44), False),
            correct_winding(ring(438, 116, 44), False),
        ]
        w = 605
    elif ch == '&':
        # constructed from curves via thick stroke and a loop, mostly literary shape
        p = stroke_polygon_path(
            [
                (400, 15),
                (260, 215),
                (160, 355),
                (128, 456),
                (169, 630),
                (255, 673),
                (326, 634),
                (322, 555),
                (253, 478),
                (165, 398),
                (96, 322),
                (90, 195),
                (135, 84),
                (229, 45),
                (328, 66),
                (421, 162),
            ],
            54,
        )
        w = 514
    elif ch == '@':
        p = [
            correct_winding(ring(330, 333, 275, 48), True),
            correct_winding(ring(330, 333, 210, 48), False),
        ]
        p += stroke_polygon_path(
            [
                (475, 430),
                (475, 245),
                (520, 245),
                (565, 286),
                (577, 374),
                (560, 475),
                (490, 548),
                (404, 574),
                (302, 555),
                (232, 510),
                (179, 424),
                (166, 303),
                (215, 235),
                (325, 227),
                (400, 268),
                (441, 368),
            ],
            43,
        )
        w = 650
    elif ch == '^':
        p = stroke_polygon_path([(110, 435), (265, 745), (420, 435)], 55)
        w = 525
    elif ch == '~':
        p = stroke_polygon_path(
            [(55, 330), (145, 400), (230, 350), (315, 310), (400, 380)], 46
        )
        w = 450
    elif ch == '`':
        p = [[(100, 680), (154, 690), (198, 544), (155, 544)]]
        w = 240
    elif ch == '$':
        p = [simple_rect(262, -75, 325, 780)]
        p += stroke_polygon_path(
            [
                (465, 625),
                (390, 689),
                (242, 700),
                (134, 645),
                (104, 550),
                (148, 457),
                (262, 401),
                (373, 354),
                (452, 272),
                (462, 161),
                (410, 75),
                (300, 30),
                (160, 56),
                (101, 113),
            ],
            64,
        )
        w = 575
    elif ch == '-':
        pass
    else:
        return None, None
    # Ensure winding on all filled outer paths. Manual paths may be self-overlapping,
    # but outlines are still useful display punctuation; handled individually where needed.
    p = [
        correct_winding([(round(x, 2), round(y, 2)) for x, y in arr], True)
        if signed_area(arr) > 0
        else arr
        for arr in p
    ]
    return polygon_pen(p), (w, 0)


def build(outdir=OUT):
    im = Image.open(SPECIMEN).convert('RGBA')
    glyphs, metrics, diag = construct_traced(im)
    pen = TTGlyphPen(None)
    pen.moveTo((65, 0))
    pen.lineTo((535, 0))
    pen.lineTo((535, 700))
    pen.lineTo((65, 700))
    pen.closePath()
    # no separate hole in .notdef: simple empty rectangle
    glyphs['.notdef'] = pen.glyph()
    metrics['.notdef'] = (600, 65)
    ascii_order = [chr(i) for i in range(32, 127)] + list('‘’“”–—…•°')
    for ch in ascii_order:
        gn = glyph_name(ch)
        if gn in glyphs:
            continue
        g, m = manual_punctuation(ch)
        if g is None:
            # remaining symbols represented by clean empty box, intentionally not fabricated
            pen = TTGlyphPen(None)
            pen.moveTo((45, 50))
            pen.lineTo((365, 50))
            pen.lineTo((365, 660))
            pen.lineTo((45, 660))
            pen.closePath()
            g = pen.glyph()
            m = (410, 45)
        glyphs[gn] = g
        metrics[gn] = m
    # Brand-specific leaf 'O' as an optional OpenType stylistic alternate.
    # The rest of the font keeps a normal O for ordinary words.
    leaf_pen = TTGlyphPen(None)
    glyphs['O'].draw(leaf_pen, None)
    # The leaf grows inside the O's counter (no effect on exterior spacing).
    leaf_pen.moveTo((282, 198))
    leaf_pen.qCurveTo((276, 383), (440, 506))
    leaf_pen.qCurveTo((453, 333), (282, 198))
    leaf_pen.closePath()
    glyphs['O.leaf'] = leaf_pen.glyph()
    metrics['O.leaf'] = metrics['O']
    order = ['.notdef'] + [glyph_name(ch) for ch in ascii_order] + ['O.leaf']
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({ord(ch): glyph_name(ch) for ch in ascii_order})
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ASCENDER, descent=DESCENDER)
    fb.setupOS2(
        sTypoAscender=ASCENDER,
        sTypoDescender=DESCENDER,
        usWinAscent=ASCENDER,
        usWinDescent=-DESCENDER,
        sxHeight=530,
        sCapHeight=700,
        usWeightClass=600,
        usWidthClass=5,
        fsSelection=0x40,
    )
    fb.setupNameTable(
        {
            'familyName': 'KoBOLD Display',
            'styleName': 'Regular',
            'uniqueFontIdentifier': 'Prajwal Bhattaram KoBOLD Display v2',
            'fullName': 'KoBOLD Display Regular',
            'psName': 'KoBOLDDisplay-Regular',
            'version': 'Version 2.0',
            'copyright': 'Copyright 2026 Prajwal Bhattaram. Designed for the KoBOLD project.',
            'designer': 'Prajwal Bhattaram (assisted design and tracing)',
            'description': 'KoBOLD Display v2, a display serif reconstructed and refined from the KoBOLD concept lettering.',
        }
    )
    fb.setupPost()
    fb.setupMaxp()
    fb.setupHead()
    dest = outdir / 'KoBOLDDisplay-v2-Regular.ttf'
    fb.save(dest)
    font = TTFont(dest)
    # GPOS kerning for select high-impact literary display pairs.
    kern = {
        'AV': -85,
        'AW': -68,
        'AY': -95,
        'AT': -34,
        'AX': -25,
        'AO': -20,
        'VA': -86,
        'WA': -66,
        'YA': -97,
        'TA': -61,
        'To': -55,
        'Ta': -54,
        'Te': -46,
        'Tr': -39,
        'Ty': -51,
        'Tu': -20,
        'T.': -65,
        'T,': -63,
        'T-': -44,
        'Vo': -49,
        'Va': -54,
        'Ve': -35,
        'V.': -70,
        'V,': -65,
        'Wo': -33,
        'Wa': -44,
        'We': -28,
        'Yo': -63,
        'Ya': -61,
        'Ye': -56,
        'LT': -50,
        'LV': -62,
        'LW': -60,
        'LY': -67,
        'LO': -18,
        'Ko': -21,
        'KA': -20,
        'Ke': -23,
        'Pa': -31,
        'Po': -26,
        'Fo': -34,
        'Fa': -44,
        'Fe': -26,
        'F.': -58,
        'F,': -58,
        'ro': -21,
        'ry': -11,
        'ra': -11,
        're': -11,
        'rv': -17,
        'ov': -15,
        'ow': -14,
        'oy': -19,
        'oo': -8,
        'oa': -8,
        'Yo': -60,
        'QU': -12,
        'QU': -12,
        'rt': -11,
        'st': -8,
        'Th': -28,
        'ly': -21,
        'll': -9,
        'oo': -7,
        'Tu': -15,
    }
    lines = []
    for pair, amount in kern.items():
        a, b = pair[0], pair[1]
        if a in ascii_order and b in ascii_order:
            lines.append(f'pos {glyph_name(a)} {glyph_name(b)} {amount};')
    fea = (
        'languagesystem DFLT dflt;\nfeature kern {\n'
        + '\n'.join(lines)
        + '\n} kern;\nfeature ss01 { sub O by O.leaf; } ss01;\n'
    )
    addOpenTypeFeaturesFromString(font, fea)
    font.save(dest)
    # local QA build web font (not distributed)
    f2 = TTFont(dest)
    f2.flavor = 'woff2'
    f2.save(outdir / 'KoBOLDDisplay-v2-Regular.woff2')
    (outdir / 'glyph_metrics.json').write_text(
        json.dumps(
            {
                'source_specimen': SPECIMEN.name,
                'units_per_em': UPM,
                'cap_height': 700,
                'x_height': 530,
                'ascent': ASCENDER,
                'descent': DESCENDER,
                'glyph_count': len(order),
                'metrics': diag,
                'kerning_pairs': kern,
                'alternate': 'O.leaf (OpenType ss01)',
            },
            indent=2,
        ),
        encoding='utf-8',
    )
    return dest


def preview(ttf_path):
    print('Font built for QA:', ttf_path)
    # Visually compare with v1, and render character coverage at readable sizes.
    paper = (247, 245, 237)
    ink = (27, 69, 52)
    amber = (177, 103, 20)
    navy = (61, 83, 87)
    size = (1750, 1260)
    canvas = Image.new('RGB', size, paper)
    dr = ImageDraw.Draw(canvas)
    heading = ImageFont.truetype(str(ttf_path), 108)
    sub = ImageFont.truetype(str(ttf_path), 71)
    alphabet = ImageFont.truetype(str(ttf_path), 46)
    label = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 27)
    dr.text((62, 45), 'KoBOLD', font=heading, fill=ink, features=['ss01'])
    dr.text((70, 195), 'The Kobold’s Tunnel', font=sub, fill=ink)
    dr.text(
        (72, 320), 'To boldly go where no Kobold has gone before!', font=sub, fill=amber
    )
    dr.line([(70, 454), (1680, 454)], fill=(166, 176, 161), width=2)
    dr.text((71, 482), 'Uppercase', font=label, fill=navy)
    dr.text((71, 530), 'ABCDEFGHIJKLM', font=alphabet, fill=ink)
    dr.text((71, 602), 'NOPQRSTUVWXYZ', font=alphabet, fill=ink)
    dr.text((71, 698), 'Lowercase', font=label, fill=navy)
    dr.text((71, 741), 'abcdefghijklm', font=alphabet, fill=ink)
    dr.text((71, 808), 'nopqrstuvwxyz', font=alphabet, fill=ink)
    dr.text((71, 905), 'Figures and punctuation', font=label, fill=navy)
    dr.text(
        (71, 952), '0123456789   ! ? , . : ; - ( ) [ ] + = /', font=alphabet, fill=ink
    )
    dr.text(
        (71, 1004), '‘Kobold’   “Your library”   –  —  …  •', font=alphabet, fill=ink
    )
    dr.text(
        (71, 1080),
        'A display face for titles and short labels; not intended for body text.',
        font=label,
        fill=navy,
    )
    dr.text(
        (71, 1155),
        'v2: alpha-derived silhouettes, consistent scale, tuned margins & kerning',
        font=label,
        fill=navy,
    )
    dst = OUT / 'KoBOLDDisplay-v2-Specimen.png'
    canvas.save(dst)
    # Side-by-side detailed render for optical QA
    return dst


if __name__ == '__main__':
    path = build()
    print('Preview:', preview(path))
