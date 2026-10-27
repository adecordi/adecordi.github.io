# Crea immagine.png (400x200, azzurra) senza librerie esterne.
import struct
import zlib

w, h, rgb = 400, 200, (135, 206, 235)
raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


with open("immagine.png", "wb") as f:
    f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
