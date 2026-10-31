// Filtro di lettura «Notte» / «Seppia» dal menu «Altro» (31/10/2026): agisce solo sull'immagine della pagina,
// si ricorda alla riapertura, «Colori normali» lo toglie.
const { chromium } = require("playwright");
const { SHOTS, BASE, check, watchErrors, openFixture } = require("./common.cjs");

const PAGINA = ".page[data-page-number='1']";
const filtroPagina = (page) => page.$eval(PAGINA + " .canvasWrapper", (e) => getComputedStyle(e).filter);
const filtroBody = (page) => page.evaluate(() => document.body.dataset.filtro || "");
const apriDoc = async (page) => {
  await openFixture(page, "doc.pdf");
  await page.waitForSelector(PAGINA + " .textLayer span");
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  watchErrors(page, errors);
  await page.goto(BASE);
  check("senza documento «Altro» non c'è", await page.isHidden("#btnAltro"));
  await apriDoc(page);
  check("con il documento «Altro» compare", await page.isVisible("#btnAltro"));
  check("all'inizio nessun filtro", (await filtroPagina(page)) === "none" && (await filtroBody(page)) === "");

  await page.click("#btnAltro");
  await page.waitForSelector("#menuAltro:not([hidden])");
  const voci = await page.$$eval("#menuAltro [data-filtro]", (a) => a.map((b) => `${b.dataset.filtro}:${b.getAttribute("aria-checked")}`).join(","));
  check("tre modi, «Colori normali» spuntato", voci === ":true,notte:false,seppia:false", voci);
  await page.click("#menuAltro [data-filtro='notte']");
  check("il menu si chiude dopo la scelta", await page.isHidden("#menuAltro"));
  check("Notte: la pagina è invertita", /invert/.test(await filtroPagina(page)) && (await filtroBody(page)) === "notte", await filtroPagina(page));
  check("il testo selezionabile non è filtrato", (await page.$eval(PAGINA + " .textLayer", (e) => getComputedStyle(e).filter)) === "none");
  await page.screenshot({ path: SHOTS + "filtro-notte.png" });

  // ricaricando, il filtro c'è già prima del documento e resta sul documento riaperto
  await page.reload();
  check("dopo la ricarica il filtro è già impostato", (await filtroBody(page)) === "notte");
  await apriDoc(page);
  check("riaperto il documento è ancora notte", /invert/.test(await filtroPagina(page)), await filtroPagina(page));
  await page.click("#btnAltro");
  check("nel menu «Notte» è spuntato", (await page.getAttribute("#menuAltro [data-filtro='notte']", "aria-checked")) === "true");
  await page.click("#menuAltro [data-filtro='seppia']");
  check("Seppia", /sepia/.test(await filtroPagina(page)) && (await filtroBody(page)) === "seppia", await filtroPagina(page));
  await page.screenshot({ path: SHOTS + "filtro-seppia.png" });
  await page.click("#btnAltro");
  await page.click("#menuAltro [data-filtro='']");
  check("Colori normali: nessun filtro", (await filtroPagina(page)) === "none" && (await filtroBody(page)) === "", await filtroPagina(page));
  check("e la scelta è ricordata", (await page.evaluate(() => localStorage.getItem("lettore-filtro"))) === null);

  await page.click("#btnAltro");
  await page.keyboard.press("Escape");
  check("Escape chiude il menu", await page.isHidden("#menuAltro") && (await page.getAttribute("#btnAltro", "aria-expanded")) === "false");
  check("nessun errore nella pagina", !errors.length, errors.join(" | "));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
