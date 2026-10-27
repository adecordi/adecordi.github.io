# Varianti danneggiate di doc.pdf.p7m: contenuto modificato e firma corrotta.
b = bytearray(open("doc.pdf.p7m", "rb").read())
i = b.find(b"%PDF-1.")
b[i + 7] = ord("9") if b[i + 7] != ord("9") else ord("8")
open("doc_alterato.pdf.p7m", "wb").write(b)

b = bytearray(open("doc.pdf.p7m", "rb").read())
b[len(b) - 40] ^= 0xFF
open("doc_firma_corrotta.pdf.p7m", "wb").write(b)
