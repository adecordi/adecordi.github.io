// Sottolineare su una scansione raddrizzata da «Ruota» (30/10/2026: la sottolineatura finiva spostata, e a sinistra
// della pagina compariva una striscia blu di a-capo selezionati).
const { chromium } = require("playwright");
const path = require("path");
const { BASE, SHOTS, check, watchErrors } = require("./common.cjs");

const SCANSIONE = path.join(__dirname, "..", "pdf", "esempi", "modulo-di-prova-scansionato.pdf");

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1300, height: 1000 } });
  const errors = [];
  watchErrors(page, errors);
  await page.goto(BASE);
  await page.setInputFiles("#fileInput", SCANSIONE);
  await page.waitForSelector(".page[data-page-number='1'] .ocrLayer span", { timeout: 90000 });
  await page.waitForSelector("#btnRaddrizza:not([hidden])", { timeout: 30000 }); // compare da solo sulle scansioni storte
  await page.click("#btnRaddrizza");
  await page.waitForFunction(() => /raddrizzat/.test(document.getElementById("toast").textContent), null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const riga = page.locator(".page[data-page-number='1'] .ocrLayer span", { hasText: "informativa" }).first();
  await riga.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const r = await riga.boundingBox();
  // trascinando con il mouse sulla riga, dall'inizio alla fine della scritta
  // coordinate INTERE, come un mouse vero: con i decimali Chrome arrotonda il punto di partenza e su alcune
  // parole la selezione non parte (era un artefatto della prova, non un difetto per chi usa il mouse)
  const yy = Math.round(r.y + r.height / 2);
  await page.mouse.move(Math.round(r.x + 2), yy);
  await page.mouse.down();
  await page.mouse.move(Math.round(r.x + r.width - 2), yy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  // niente a-capo colorati: il colore della selezione sugli a-capo è trasparente
  const br = await page.$eval(".page[data-page-number='1'] .ocrLayer br", (e) => getComputedStyle(e, "::selection").backgroundColor);
  check("a-capo selezionati senza colore (niente striscia a sinistra)", /rgba\(0, 0, 0, 0\)|transparent/.test(br), br);
  await page.locator("button", { hasText: "Sottolinea" }).first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(SHOTS, "sottolinea-storta.png"), clip: { x: Math.max(0, r.x - 40), y: Math.max(0, r.y - 30), width: 600, height: 90 } });
  // la sottolineatura: il riquadro dell'editor di PDF.js appena creato
  const sotto = await page.$eval(".page[data-page-number='1'] .annotationEditorLayer .highlightEditor:last-of-type", (e) => {
    const q = e.getBoundingClientRect();
    return { x: q.x, y: q.y, w: q.width, h: q.height };
  });
  const centroRiga = r.x + r.width / 2;
  const centroSotto = sotto.x + sotto.w / 2;
  check("sottolineatura sotto la riga, non spostata", Math.abs(centroSotto - centroRiga) < 4, `${Math.round(centroSotto - centroRiga)} px`);
  check("e alla sua altezza (sotto la base della scritta)", sotto.y > r.y + r.height * 0.6 && sotto.y < r.y + r.height * 1.15,
    `riga ${Math.round(r.y)}-${Math.round(r.y + r.height)}, sottolineatura a ${Math.round(sotto.y)}`);
  check("larga quanto la riga", Math.abs(sotto.w - r.width) < r.width * 0.15, `${Math.round(sotto.w)} su ${Math.round(r.width)}`);
  check("nessun errore nella pagina", errors.length === 0, errors.join(" | "));
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
