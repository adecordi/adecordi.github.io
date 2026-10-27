# PDF di 40 pagine con testo e immagine, per i test di prestazioni e stampa.
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
import random
random.seed(1)
c = canvas.Canvas("grande.pdf", pagesize=A4)
img = ImageReader("immagine.png")
words = "contratto fornitura servizi pagamento clausola parti obbligo termine recesso foro competente articolo comma".split()
for i in range(1, 41):
    w, h = A4
    c.setFont("Helvetica-Bold", 20); c.drawString(60, h - 70, f"Capitolato tecnico - pagina {i}")
    c.drawImage(img, 60, h - 260, width=300, height=150)
    c.setFont("Times-Roman", 10)
    for j in range(45):
        c.drawString(60, h - 290 - j * 12, " ".join(random.choice(words) for _ in range(14)))
    c.showPage()
c.save()
