// Uscire da un documento con firme, note o campi non salvati: si chiede se salvare (30/10/2026).
const { chromium } = require("playwright");
const { FX, BASE, check, watchErrors } = require("./common.cjs");

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  watchErrors(page, errors);
  const apri = (nome) => page.setInputFiles("#fileInput", FX + nome);
  const titolo = () => page.textContent("#docTitle");
  const firma = async () => {
    await page.click("#btnSign");
    await page.waitForSelector(".sign-dialog[open]");
    await page.fill(".sign-dialog .sign-typed", "Mario Rossi");
    await page.click(".sign-dialog .btn.primary");
    await page.waitForSelector(".stampEditor", { timeout: 10000 });
    await page.waitForTimeout(500);
    await page.click("#signDone").catch(() => {});
    await page.waitForTimeout(300);
  };
  await page.goto(BASE);

  await apri("doc.pdf");
  await page.waitForSelector(".page[data-page-number='1'] .textLayer span");
  await apri("scansione.pdf");
  await page.waitForTimeout(1500);
  check("senza modifiche si cambia file senza domande", await page.isHidden(".uscita-dialog") && /scansione/.test(await titolo()));

  await firma();
  await apri("doc.pdf");
  await page.waitForSelector(".uscita-dialog[open]", { timeout: 5000 });
  check("con una firma non salvata chiede", true);
  await page.click(".uscita-dialog button[value=annulla]");
  await page.waitForTimeout(500);
  check("«Annulla» resta sul documento", /scansione/.test(await titolo()));

  await apri("doc.pdf");
  await page.waitForSelector(".uscita-dialog[open]");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click(".uscita-dialog button[value=salva]")]);
  check("«Salva» scarica il documento", /scansione/.test(dl.suggestedFilename()), dl.suggestedFilename());
  await page.waitForFunction(() => /doc/.test(document.getElementById("docTitle").textContent), null, { timeout: 10000 });
  check("e poi apre l'altro", true);

  await page.waitForSelector(".page[data-page-number='1'] .textLayer span");
  await firma();
  await apri("scansione.pdf");
  await page.waitForSelector(".uscita-dialog[open]");
  await page.click(".uscita-dialog button[value=esci]");
  await page.waitForFunction(() => /scansione/.test(document.getElementById("docTitle").textContent), null, { timeout: 10000 });
  check("«Esci senza salvare» apre l'altro", true);

  // Bozza salvata da sola: firma, attesa del salvataggio automatico, «crash» (ricarica) e ripresa
  await firma();
  await page.waitForTimeout(33000);
  page.removeAllListeners("dialog");
  page.on("dialog", (d) => d.accept());
  await page.reload();
  await page.waitForSelector("#bozzaBox:not([hidden])", { timeout: 10000 });
  check("dopo un crash la pagina iniziale offre la bozza", (await page.textContent("#bozzaBox")).includes("scansione.pdf"));
  await page.click("#bozzaBox .btn.primary");
  await page.waitForSelector(".page[data-page-number='1'] canvas", { timeout: 15000 });
  check("«Riprendi» riapre il documento con la firma", /scansione/.test(await titolo()) && (await page.$$(".stampEditor, .annotationLayer .stampAnnotation, section.stampAnnotation")).length > 0);
  check("nessun errore nella pagina", errors.length === 0, errors.join(" | "));
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
