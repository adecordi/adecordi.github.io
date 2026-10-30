// Il testo letto sulle scansioni storte (30/10/2026): le righe vuote ____ non diventano testo selezionabile, e
// ogni parola ha la sua fascia (prima una per riga intera, alta come due righe sulle scansioni storte).
const { chromium } = require("playwright");
const path = require("path");
const { BASE, SHOTS, check, watchErrors } = require("./common.cjs");

const SCANSIONE = path.join(__dirname, "..", "pdf", "esempi", "scheda-fornitore-gdo.pdf");

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1300, height: 1000 } });
  const errors = [];
  watchErrors(page, errors);
  await page.goto(BASE);
  await page.setInputFiles("#fileInput", SCANSIONE);
  await page.waitForSelector(".page[data-page-number='1'] .ocrLayer span", { timeout: 90000 });
  await page.click("#btnRotate");
  await page.waitForFunction(() => /raddrizzat/.test(document.getElementById("toast").textContent), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const fasce = await page.$$eval(".page[data-page-number='1'] .ocrLayer span", (ss) => ss.map((s) => ({ t: s.textContent, h: s.getBoundingClientRect().height })));
  const senza = fasce.filter((f) => !/[\p{L}\p{N}]/u.test(f.t));
  check("nessuna riga vuota ____ letta come testo", senza.length === 0, senza.map((f) => JSON.stringify(f.t)).slice(0, 5).join(" "));
  // come nella foto di Alessandro: da «Ragione sociale» trascinando giù di tre righe
  const inizio = await page.locator(".page[data-page-number='1'] .ocrLayer span", { hasText: "Ragione" }).first().boundingBox();
  await page.mouse.move(inizio.x + 2, inizio.y + inizio.height / 2);
  await page.mouse.down();
  await page.mouse.move(inizio.x + 400, inizio.y + inizio.height / 2 + 90, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, "ocr-storta.png"), clip: { x: Math.max(0, inizio.x - 30), y: Math.max(0, inizio.y - 40), width: 900, height: 200 } });
  const scelto = await page.evaluate(() => getSelection().toString());
  // fra un'etichetta e l'altra solo l'a-capo: niente parole inventate sopra le righe vuote
  check("la selezione prende solo le etichette, niente parole inventate sulle righe",
    /Ragione sociale\s*\n\s*Sede legale\s*\n\s*Sede dello stabilimento/.test(scelto), JSON.stringify(scelto.slice(0, 90)));
  check("nessun errore nella pagina", errors.length === 0, errors.join(" | "));
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
