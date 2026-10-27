# Marche temporali di prova: .tsd (RFC 5544), .m7m (MIME) e p7m con marca sulla firma.
import subprocess, base64
def enc_len(n):
    if n < 0x80: return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, 'big'); return bytes([0x80 | len(b)]) + b
def tlv(tag, body): return bytes([tag]) + enc_len(len(body)) + body
def oid(s):
    a = [int(x) for x in s.split('.')]; out = bytes([a[0]*40 + a[1]])
    for v in a[2:]:
        chunk = [v & 0x7f]; v >>= 7
        while v: chunk.append(0x80 | (v & 0x7f)); v >>= 7
        out += bytes(reversed(chunk))
    return tlv(0x06, out)
def parse(b, pos=0):
    tag = b[pos]; l = b[pos+1]; p = pos + 2
    if l & 0x80:
        n = l & 0x7f; l = int.from_bytes(b[p:p+n], 'big'); p += n
    return tag, b[p:p+l], p + l
def kids(body):
    out = []; p = 0
    while p < len(body):
        t, c, e = parse(body, p); out.append((t, c)); p = e
    return out
def run(*a): subprocess.run(a, check=True, capture_output=True)

def timestamp(data_file, out_prefix):
    run('openssl','ts','-query','-data',data_file,'-sha256','-cert','-out',out_prefix+'.tsq')
    run('openssl','ts','-reply','-queryfile',out_prefix+'.tsq','-config','tsa.cnf','-section','tsa_config1','-out',out_prefix+'.tsr')
    run('openssl','ts','-reply','-in',out_prefix+'.tsr','-token_out','-out',out_prefix+'.tst')
    return open(out_prefix+'.tsr','rb').read(), open(out_prefix+'.tst','rb').read()

p7m = open('doc.pdf.p7m','rb').read()
# --- TSD (RFC 5544)
tsr, tok = timestamp('doc.pdf.p7m', 'tsd')
meta = tlv(0x30, tlv(0x01, b'\x00') + tlv(0x0c, 'doc.pdf.p7m'.encode()))
tsd = tlv(0x30, tlv(0x02, b'\x01') + meta + tlv(0x04, p7m) + tlv(0xA0, tlv(0x30, tok)))
open('doc.pdf.tsd','wb').write(tlv(0x30, oid('1.2.840.113549.1.9.16.1.31') + tlv(0xA0, tsd)))
# --- M7M (MIME)
b64 = lambda d: '\r\n'.join(base64.b64encode(d).decode()[i:i+76] for i in range(0, len(base64.b64encode(d)), 76))
mime = ('MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="----=_Part_0_123"\r\n\r\n'
        'This is a multi-part message in MIME format.\r\n'
        '------=_Part_0_123\r\nContent-Type: application/pkcs7-mime; smime-type=signed-data; name="doc.pdf.p7m"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="doc.pdf.p7m"\r\n\r\n'
        + b64(p7m) + '\r\n------=_Part_0_123\r\nContent-Type: application/timestamp-reply; name="doc.pdf.tsr"\r\nContent-Transfer-Encoding: base64\r\n\r\n'
        + b64(tsr) + '\r\n------=_Part_0_123--\r\n')
open('doc.pdf.m7m','wb').write(mime.encode())
# --- p7m con marca temporale sulla firma (attributo non firmato)
t, ci, _ = parse(p7m); ci_k = kids(ci)
sd_wrapper = ci_k[1][1]; sd_t, sd_body, _ = parse(sd_wrapper); sd_k = kids(sd_body)
si_set = sd_k[-1][1]; si_t, si_body, _ = parse(si_set); si_k = kids(si_body)
sig = si_k[-1][1]; open('sig.bin','wb').write(sig)
_, sigtok = timestamp('sig.bin', 'sig')
unsigned = tlv(0xA1, tlv(0x30, oid('1.2.840.113549.1.9.16.2.14') + tlv(0x31, sigtok)))
new_si = tlv(0x30, si_body + unsigned)
new_sd = tlv(0x30, b''.join(tlv(t2, c) for t2, c in sd_k[:-1]) + tlv(0x31, new_si))
out = tlv(0x30, tlv(ci_k[0][0], ci_k[0][1]) + tlv(0xA0, new_sd))
open('doc_marca.pdf.p7m','wb').write(out)
