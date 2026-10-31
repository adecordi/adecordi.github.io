// «Traduci» tutto il documento, «Sottolinea i punti importanti» e tempo di lettura (31/10/2026), con un compilatore finto.
const { chromium } = require("playwright");
const { FX, BASE, check, watchErrors } = require("./common.cjs");

const FAKE = "https://compilatore.prova";

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  watchErrors(page, errors);
  const chieste = [];
  await page.route(FAKE + "/**", async (route) => {
    const req = route.request();
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const corpo = JSON.parse(req.postData());
    chieste.push(corpo.compito);
    const out = corpo.compito === "punti"
      ? { punti: [
        { pagina: 1, frase: "Riga 2: contratto di fornitura, testo ricercabile perla1.", perche: "Riga di prova" },
        { pagina: 2, frase: "Riga 3: contratto di fornitura", perche: "Seconda pagina" },
        { pagina: 1, frase: "questa frase non c'è nel documento", perche: "Inventata" }] }
      : { riassunto: "**Pagina 1**\n\nTest document - page 1" };
    return route.fulfill({ status: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(out) });
  });
  await page.goto(BASE + "#compilatore=" + encodeURIComponent(FAKE) + "&chiave=prova");
  await page.setInputFiles("#fileInput", FX + "doc.pdf");
  await page.waitForSelector(".page[data-page-number='1'] .textLayer span");
  await page.waitForSelector("#tempoLettura:not([hidden])", { timeout: 15000 });
  check("tempo di lettura accanto al nome", /≈ \d+ min/.test(await page.textContent("#tempoLettura")), await page.textContent("#tempoLettura"));
  check("anche nella proposta di riassunto", /min di lettura/.test(await page.textContent(".avviso-storta")));
  check("tasti Traduci e Punti visibili", (await page.isVisible("#btnTraduci")) && (await page.isVisible("#btnPunti")));

  await page.click("#btnTraduci");
  await page.waitForSelector("#sumPanel:not([hidden])", { timeout: 10000 });
  check("Traduci: traduzione nel pannello", (await page.textContent("#sumPanel")).includes("Test document") && chieste.includes("traduci"));

  await page.click("#btnPunti");
  await page.waitForFunction(() => /Punti importanti/.test(document.querySelector("#sumPanel h2").textContent), null, { timeout: 10000 });
  await page.waitForTimeout(800);
  const sottolineature = await page.$$(".annotationEditorLayer .highlightEditor");
  check("sottolineati i punti ritrovati sulle pagine", sottolineature.length >= 1, `${sottolineature.length} sottolineature`);
  const pannello = await page.textContent("#sumPanel");
  check("nel pannello i punti col perché", pannello.includes("Riga di prova") && pannello.includes("Seconda pagina"));
  check("quello non ritrovato è segnalato", pannello.includes("non ritrovato"));
  check("messaggio: 2 punti su 3", /Sottolineati 2 punti su 3/.test(await page.textContent("#toast")), await page.textContent("#toast"));
  // la sottolineatura della pagina 1 sta sotto la riga 2
  const riga2 = await page.locator(".page[data-page-number='1'] .textLayer span", { hasText: "Riga 2" }).first().boundingBox();
  const sotto = await page.$eval(".page[data-page-number='1'] .annotationEditorLayer .highlightEditor", (e) => { const q = e.getBoundingClientRect(); return { x: q.x, y: q.y, w: q.width }; });
  check("sottolineatura sotto la riga giusta", Math.abs(sotto.y - (riga2.y + riga2.height * 0.84)) < riga2.height * 0.6 && Math.abs(sotto.x - riga2.x) < 12,
    `riga ${Math.round(riga2.y)}+${Math.round(riga2.height)}, sottolineatura a ${Math.round(sotto.y)}`);
  await page.click("#sumPanel .fill-list li:nth-child(2)");
  await page.waitForTimeout(500);
  check("cliccando un punto si va alla sua pagina", (await page.inputValue("#pageNumber")) === "2");
  check("nessun errore nella pagina", errors.length === 0, errors.join(" | "));
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
