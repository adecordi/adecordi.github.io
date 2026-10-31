# PDF di prova (3 pagine, una orizzontale, con link) e la sua versione protetta da password "segreta".
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas
c = canvas.Canvas("doc.pdf", pagesize=A4)
c.setTitle("Documento di prova")
for i in range(1, 4):
    if i == 3:
        c.setPageSize(landscape(A4))
    w, h = c._pagesize
    c.setFont("Helvetica-Bold", 28)
    c.drawString(60, h - 100, f"Documento di prova - pagina {i}")
    c.setFont("Helvetica", 14)
    for j in range(20):
        c.drawString(60, h - 150 - j * 22, f"Riga {j+1}: contratto di fornitura, testo ricercabile perla{i}.")
    c.linkURL("https://example.com", (60, 40, 300, 60), relative=0)
    c.drawString(60, 45, "Link di esempio a example.com")
    c.showPage()
c.save()
from pypdf import PdfReader, PdfWriter
r = PdfReader("doc.pdf"); w = PdfWriter()
for p in r.pages: w.add_page(p)
w.encrypt("segreta", algorithm="AES-256")
w.write("protetto.pdf")

# indice.pdf: 3 pagine con un indice (outline) a due livelli, per il pannello «Segnalibri» (31/10/2026).
VOCI = [  # (titolo, livello, pagina)
    ("Capitolo 1 - Premesse", 0, 1), ("1.1 Oggetto", 1, 1), ("1.2 Definizioni", 1, 1),
    ("Capitolo 2 - Condizioni", 0, 2), ("2.1 Pagamenti", 1, 2), ("2.2 Consegna", 1, 3),
    ("Capitolo 3 - Firme", 0, 3),
]
c = canvas.Canvas("indice.pdf", pagesize=A4)
c.setTitle("Documento con indice")
for i in range(1, 4):
    w, h = A4
    c.setFont("Helvetica-Bold", 28)
    c.drawString(60, h - 100, f"Documento con indice - pagina {i}")
    c.setFont("Helvetica", 14)
    y = h - 150
    for n, (titolo, livello, pagina) in enumerate(VOCI):
        if pagina != i:
            continue
        c.bookmarkPage(f"voce{n}", fit="XYZ", left=0, top=y + 20)
        c.addOutlineEntry(titolo, f"voce{n}", level=livello)
        c.drawString(60 + 24 * livello, y, titolo)
        y -= 30
    c.showPage()
c.save()
