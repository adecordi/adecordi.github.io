// Aperto un file, C.A.R.T.A. propone quello che serve (31/10/2026): Raddrizza (scansione storta), Compila (modulo),
// Riassumi (documento lungo). Con un compilatore finto collegato.
const { chromium } = require("playwright");
const path = require("path");
const { FX, BASE, check, watchErrors } = require("./common.cjs");

const ESEMPI = path.join(__dirname, "..", "pdf", "esempi");
const FAKE = "https://compilatore.prova";

(async () => {
  const b = await chromium.launch();
  const nuova = async (collegato) => {
    const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    watchErrors(page, errors);
    await page.route(FAKE + "/**", (route) => route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } }));
    await page.goto(collegato ? BASE + "#compilatore=" + encodeURIComponent(FAKE) + "&chiave=prova" : BASE);
    return { page, errors };
  };
  const azioni = (page) => page.$$eval(".avviso-storta:not([hidden]) button[data-azione]", (bb) => bb.map((x) => x.dataset.azione).join(","));

  // modulo con i campi
  let { page, errors } = await nuova(true);
  await page.setInputFiles("#fileInput", path.join(ESEMPI, "conto-corrente-dedicato.pdf"));
  await page.waitForSelector(".avviso-storta:not([hidden])", { timeout: 20000 });
  check("modulo con i campi: propone «Compila»", (await azioni(page)) === "compila", await azioni(page));
  check("con la spiegazione", /modulo da compilare/.test(await page.textContent(".avviso-storta")));
  check("nessun errore nella pagina", errors.length === 0, errors.join(" | "));
  await page.close();

  // scansione storta: prima Raddrizza, poi (letto il testo) anche Compila; raddrizzata, resta Compila
  ({ page, errors } = await nuova(true));
  await page.setInputFiles("#fileInput", path.join(ESEMPI, "scheda-fornitore-gdo.pdf"));
  await page.waitForFunction(() => document.querySelectorAll(".avviso-storta:not([hidden]) button[data-azione]").length === 2, null, { timeout: 90000 });
  check("scansione storta: Raddrizza e Compila", (await azioni(page)) === "raddrizza,compila", await azioni(page));
  await page.click(".avviso-storta button[data-azione=raddrizza]");
  await page.waitForTimeout(800);
  check("raddrizzata, resta «Compila»", (await azioni(page)) === "compila", await azioni(page));
  check("nessun errore nella pagina", errors.length === 0, errors.join(" | "));
  await page.close();

  // documento lungo, non un modulo
  ({ page, errors } = await nuova(true));
  await page.setInputFiles("#fileInput", FX + "doc.pdf");
  await page.waitForSelector(".avviso-storta:not([hidden])", { timeout: 20000 });
  check("documento di 3 pagine: propone «Riassumi»", (await azioni(page)) === "riassumi", await azioni(page));
  await page.close();

  // senza compilatore collegato niente «Compila»
  ({ page, errors } = await nuova(false));
  await page.setInputFiles("#fileInput", path.join(ESEMPI, "conto-corrente-dedicato.pdf"));
  await page.waitForSelector(".page canvas");
  await page.waitForTimeout(3000);
  check("senza compilatore nessuna proposta di compilare", !(await page.isVisible(".avviso-storta")) || !(await azioni(page)).includes("compila"));
  await page.close();
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
