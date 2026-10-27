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
