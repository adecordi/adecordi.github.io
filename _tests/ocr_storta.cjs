// Il testo letto sulle scansioni storte (30/10/2026): si legge la pagina raddrizzata, le righe vuote ____ non
// diventano testo selezionabile e ogni parola ha la sua fascia. Due scansioni: la scheda fornitore del sito
// (storta di 1,1°) e la stessa storta di 2,5° (fixtures/scheda-storta-2-5.pdf).
const { chromium } = require("playwright");
const path = require("path");
const { BASE, SHOTS, check, watchErrors } = require("./common.cjs");

const SCANSIONI = [path.join(__dirname, "..", "pdf", "esempi", "scheda-fornitore-gdo.pdf"),
  path.join(__dirname, "fixtures", "scheda-storta-2-5.pdf")];
const ETICHETTE = /Ragione sociale\s*\n\s*Sede legale\s*\n\s*Sede dello stabilimento\s*\n\s*Partita IVA\s+Telefono\s*\n\s*Attività svolta/;

(async () => {
  const b = await chromium.launch();
  for (const scansione of SCANSIONI) {
    const nome = path.basename(scansione, ".pdf");
    console.log("  " + nome);
    const page = await b.newPage({ viewport: { width: 1300, height: 1000 } });
    const errors = [];
    watchErrors(page, errors);
    await page.goto(BASE);
    await page.setInputFiles("#fileInput", scansione);
    await page.waitForSelector(".page[data-page-number='1'] .ocrLayer span", { timeout: 90000 });
    await page.waitForSelector("#btnRaddrizza:not([hidden])", { timeout: 30000 }); // compare da solo sulle scansioni storte
    await page.click("#btnRaddrizza");
    await page.waitForFunction(() => /raddrizzat/.test(document.getElementById("toast").textContent), null, { timeout: 30000 });
    await page.waitForTimeout(800);
    const fasce = await page.$$eval(".page[data-page-number='1'] .ocrLayer span", (ss) => ss.map((s) => s.textContent));
    const senza = fasce.filter((t) => !/[\p{L}\p{N}]/u.test(t));
    check("nessuna riga vuota ____ letta come testo", senza.length === 0, senza.slice(0, 5).map((t) => JSON.stringify(t)).join(" "));
    // come nella foto di Alessandro: da «Ragione sociale» trascinando giù per qualche riga
    const inizio = await page.locator(".page[data-page-number='1'] .ocrLayer span", { hasText: "Ragione" }).first().boundingBox();
    const y0 = Math.round(inizio.y + inizio.height / 2); // coordinate intere, come un mouse vero
    await page.mouse.move(Math.round(inizio.x + 2), y0);
    await page.mouse.down();
    await page.mouse.move(Math.round(inizio.x + 400), y0 + 90, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, `ocr-${nome}.png`), clip: { x: Math.max(0, inizio.x - 30), y: Math.max(0, inizio.y - 40), width: 900, height: 200 } });
    const scelto = await page.evaluate(() => getSelection().toString());
    // fra un'etichetta e l'altra solo l'a-capo: niente parole inventate sopra le righe vuote
    check("la selezione prende solo le etichette, niente parole inventate sulle righe", ETICHETTE.test(scelto), JSON.stringify(scelto.slice(0, 100)));
    check("nessun errore nella pagina", errors.length === 0, errors.join(" | "));
    await page.close();
  }
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
