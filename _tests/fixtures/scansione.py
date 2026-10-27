# Crea scansione.pdf: una pagina A4 fatta solo di un'immagine (come uno scanner),
# con due colonne di testo per provare l'OCR e la selezione a riquadro.
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

DPI = 150
w, h = int(A4[0] / 72 * DPI), int(A4[1] / 72 * DPI)
img = Image.new("L", (w, h), 255)
d = ImageDraw.Draw(img)
titolo = ImageFont.load_default(size=44)
testo = ImageFont.load_default(size=30)
d.text((120, 150), "Modulo scansionato di prova", font=titolo, fill=0)
for i in range(1, 9):
    y = 260 + i * 60
    d.text((120, 260 + i * 60), f"Sinistra {i} alfa", font=testo, fill=0)
    d.text((700, y), f"Destra {i} omega", font=testo, fill=0)

c = canvas.Canvas("scansione.pdf", pagesize=A4)
c.drawImage(ImageReader(img), 0, 0, width=A4[0], height=A4[1])
c.save()
