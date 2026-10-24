"""纯标准库 PNG 裁剪 + 最近邻放大（无 Pillow 环境下的应急工具）。

用法: python png-zoom.py <src> <x> <y> <w> <h> <scale> <out>
"""
import struct
import sys
import zlib


def read_png(path):
    data = open(path, 'rb').read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a png'
    pos = 8
    idat = b''
    w = h = bd = ct = 0
    palette = None
    trns = None
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b'IHDR':
            w, h, bd, ct, _comp, _filt, inter = struct.unpack('>IIBBBBB', chunk)
            assert inter == 0, 'interlaced png unsupported'
        elif typ == b'IDAT':
            idat += chunk
        elif typ == b'PLTE':
            palette = chunk
        elif typ == b'tRNS':
            trns = chunk
        elif typ == b'IEND':
            break

    raw = zlib.decompress(idat)
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
    bpp = max(1, ch * bd // 8)
    stride = (w * ch * bd + 7) // 8
    rows = []
    prev = bytearray(stride)
    p = 0
    for _y in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        rows.append(bytes(line))
        prev = line

    # 统一转 RGB 像素函数
    def px(x, y):
        line = rows[y]
        if ct == 3:
            idx = line[x] if bd == 8 else 0
            return palette[idx * 3:idx * 3 + 3]
        if ct == 6:
            return line[x * 4:x * 4 + 3]
        if ct == 2:
            return line[x * 3:x * 3 + 3]
        if ct == 0:
            v = line[x]
            return bytes((v, v, v))
        if ct == 4:
            v = line[x * 2]
            return bytes((v, v, v))
        return b'\x00\x00\x00'

    return w, h, px


def write_png(path, w, h, rows_rgb):
    raw = b''.join(b'\x00' + r for r in rows_rgb)

    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xFFFFFFFF)

    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
    out += chunk(b'IDAT', zlib.compress(raw, 6))
    out += chunk(b'IEND', b'')
    open(path, 'wb').write(out)


def main():
    src, x, y, w, h, scale, out = sys.argv[1:8]
    x, y, w, h, scale = int(x), int(y), int(w), int(h), int(scale)
    iw, ih, px = read_png(src)
    x = max(0, min(x, iw - 1))
    y = max(0, min(y, ih - 1))
    w = min(w, iw - x)
    h = min(h, ih - y)
    rows = []
    for yy in range(h):
        src_row = bytes(b''.join(px(x + xx, y + yy) for xx in range(w)))
        big = b''.join(src_row[i:i + 3] * scale for i in range(0, len(src_row), 3))
        for _ in range(scale):
            rows.append(big)
    write_png(out, w * scale, h * scale, rows)
    print(f'{iw}x{ih} -> crop({w}x{h})@({x},{y}) x{scale} -> {out}')


if __name__ == '__main__':
    main()
