#!/usr/bin/env python3
"""
Generate the Distro brand raster assets (favicon.ico, apple-touch-icons)
from the same hub-and-nodes mark used in public/favicon.svg and the header.

Pure standard-library implementation (zlib + struct), no image deps.

Usage: python3 scripts/gen-brand-assets.py
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "apps" / "web" / "public"

# Brand palette (matches favicon.svg gradient stops)
C1 = (0x06, 0xB6, 0xD4)  # cyan-500
C2 = (0x63, 0x66, 0xF1)  # indigo-500
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def lerp_color(p, a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def mix(c1, c2, a):
    return tuple(round(c1[i] * (1 - a) + c2[i] * a) for i in range(3))


def smoothstep(edge0, edge1, x):
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)


def sd_round_rect(px, py, cx, cy, hw, hh, r):
    """Signed distance to rounded rect centered (cx, cy)."""
    qx = abs(px - cx) - (hw - r)
    qy = abs(py - cy) - (hh - r)
    ax = max(qx, 0.0)
    ay = max(qy, 0.0)
    outside = (ax * ax + ay * ay) ** 0.5
    inside = min(max(qx, qy), 0.0)
    return outside + inside - r


def sd_circle(px, py, cx, cy, r):
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5 - r


def sd_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    denom = vx * vx + vy * vy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / denom))
    return ((px - (ax + t * vx)) ** 2 + (py - (ay + t * vy)) ** 2) ** 0.5


def render(size: int) -> bytes:
    """Return RGBA rows for the Distro mark at `size` (supersampled 3x)."""
    ss = 3
    n = size * ss
    img = bytearray()
    for y in range(size):
        row = bytearray()
        for x in range(size):
            # Accumulate supersamples
            ra = ga = ba = aa = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    px = (x + (sx + 0.5) / ss) / size
                    py = (y + (sy + 0.5) / ss) / size
                    t = (px + py) / 2.0
                    bg = lerp_color(None, C1, C2, t)

                    # rounded square backdrop
                    d = sd_round_rect(px * size, py * size, size / 2, size / 2,
                                      size / 2 - 0.5, size / 2 - 0.5, size * 0.25)
                    cov = 1.0 - smoothstep(-0.9, 0.9, d)

                    # connectors (drawn beneath nodes)
                    conn = [
                        ((0.500, 0.294), (0.443, 0.425)),
                        ((0.500, 0.294), (0.556, 0.425)),
                        ((0.443, 0.425), (0.291, 0.613)),
                        ((0.556, 0.425), (0.709, 0.613)),
                    ]
                    stroke_w = size * 0.035
                    for (ax, ay), (bx, by) in conn:
                        dc = sd_segment(px * size, py * size, ax * size, ay * size,
                                        bx * size, by * size)
                        cov_c = 0.65 * (1.0 - smoothstep(0.0, 1.0, dc - stroke_w))
                        bg = mix(bg, WHITE, cov_c)

                    # node circles
                    nodes = [
                        ((0.500, 0.500), 0.1125),
                        ((0.500, 0.216), 0.0688),
                        ((0.766, 0.656), 0.0688),
                        ((0.234, 0.656), 0.0688),
                    ]
                    for (cx, cy), r in nodes:
                        dn = sd_circle(px * size, py * size, cx * size, cy * size, r * size)
                        cov_n = 1.0 - smoothstep(-0.9, 0.9, dn)
                        bg = mix(bg, WHITE, cov_n)

                    ra += bg[0] * cov
                    ga += bg[1] * cov
                    ba += bg[2] * cov
                    aa += cov

            total = ss * ss
            row += bytes((round(ra / total), round(ga / total), round(ba / total), 255))
        img += row
    return bytes(img)


def png_encode(size: int) -> bytes:
    """Encode a single RGBA PNG at `size`."""
    raw = b""
    rgba = render(size)
    for y in range(size):
        raw += b"\x00" + rgba[y * size * 4:(y + 1) * size * 4]

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def ico_encode(entries: list[tuple[int, bytes]]) -> bytes:
    """Wrap PNG entries into an ICO container (Vista+ PNG-in-ICO)."""
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    out = bytearray(header)
    for size, data in entries:
        b = 0 if size >= 256 else size  # 0 encodes 256 in ICO headers
        out += struct.pack("<BBBBHHII", b, b, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for _, data in entries:
        out += data
    return bytes(out)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    pngs = {s: png_encode(s) for s in (16, 32, 48, 180, 256)}
    (OUT_DIR / "favicon.ico").write_bytes(ico_encode([(s, pngs[s]) for s in (16, 32, 48, 256)]))
    (OUT_DIR / "apple-touch-icon.png").write_bytes(pngs[180])
    (OUT_DIR / "apple-touch-icon-precomposed.png").write_bytes(pngs[180])
    (OUT_DIR / "favicon-256.png").write_bytes(pngs[256])
    print("wrote:", OUT_DIR)


if __name__ == "__main__":
    main()
