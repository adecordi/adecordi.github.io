// Percorso principale su desktop: PDF, p7m, firme, password, fatture, altri formati, stampa.
const { chromium } = require("playwright");
const { FX, SHOTS, BASE, check, watchErrors, openFixture, text } = require("./common.cjs");

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  watchErrors(page, errors);
  await page.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints++; }; });
  await page.goto(BASE);
  await page.screenshot({ path: SHOTS + "01-avvio.png" });

  // PDF semplice
  await openFixture(page, "doc.pdf");
  await page.waitForSelector(".page canvas");
  check("PDF: 3 pagine", (await text(page, "#pageCount")) === "/ 3");
  check("PDF: nessuna etichetta firma", await page.isHidden("#sigChip"));
  await page.keyboard.press("Control+f");
  await page.fill("#findInput", "perla2");
  await page.waitForFunction(() => /di/.test(document.getElementById("findResult").textContent));
  check("ricerca nel testo", /1 di 20/.test(await text(page, "#findResult")), await text(page, "#findResult"));
  await page.keyboard.press("Escape");
  await page.selectOption("#zoomSelect", "page-fit");
  await page.click("#btnNext");
  await page.waitForTimeout(300);
  check("pagina successiva", (await page.inputValue("#pageNumber")) === "3");

  await page.click("#btnPrint");
  await page.waitForFunction(() => window.__prints > 0, null, { timeout: 30000 });
  check("stampa: 3 pagine preparate", (await page.$$eval("#printContainer .printedPage :is(canvas,img)", (a) => a.length)) === 3);
  await page.emulateMedia({ media: "print" });
  await page.pdf({ path: SHOTS + "stampa-doc.pdf", preferCSSPageSize: true });
  await page.emulateMedia({ media: "screen" });

  // p7m firmato
  await openFixture(page, "doc.pdf.p7m");
  check("p7m: firmato da Mario Rossi", (await text(page, "#sigChip")) === "Firmato da Mario Rossi");
  await page.click("#sigChip");
  check("pannello firme: codice fiscale", (await text(page, "#sigBody")).includes("RSSMRA80A01H501U"));
  await page.screenshot({ path: SHOTS + "02-firme.png" });
  await page.click("#sigClose");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#btnDownload")]);
  check("salva il PDF estratto", download.suggestedFilename() === "doc.pdf");

  const chips = {
    "doc_alterato.pdf.p7m": ["Firma non valida", "invalid"],
    "doc_doppia.pdf.p7m.p7m": ["Firmato da 2 persone", "valid"],
    "doc.pdf.tsd": ["Firmato da Mario Rossi", "valid"],
    "doc.pdf.m7m": ["Firmato da Mario Rossi", "valid"],
    "doc_marca.pdf.p7m": ["Firmato da Mario Rossi", "valid"],
    "doc_scaduto.pdf.p7m": ["Certificato scaduto", "unknown"],
    "doc_ber.pdf.p7m": ["Firmato da Mario Rossi", "valid"],
    "doc_b64.pdf.p7m": ["Firmato da Mario Rossi", "valid"],
  };
  for (const [file, [label, cls]] of Object.entries(chips)) {
    await openFixture(page, file);
    const chip = await text(page, "#sigChip");
    check(`${file}: ${label}`, chip === label && (await page.getAttribute("#sigChip", "class")).includes(cls), chip);
  }

  // PDF protetto da password dentro un p7m
  await page.setInputFiles("#fileInput", FX + "protetto.pdf.p7m");
  await page.waitForSelector("#passwordDialog[open]");
  await page.fill("#pwInput", "sbagliata");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("pwMessage").textContent.includes("errata"));
  check("password errata segnalata", true);
  await page.click("#pwCancel");
  await page.waitForSelector("#altView .message-card");
  await page.click("#altView button");
  await page.waitForSelector("#passwordDialog[open]");
  await page.fill("#pwInput", "segreta");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".page canvas");
  check("PDF protetto aperto con la password", (await text(page, "#pageCount")) === "/ 3");

  // Fattura elettronica
  await openFixture(page, "IT01234567890_00042.xml.p7m");
  await page.waitForSelector(".invoice");
  const invoice = await text(page, ".invoice");
  const missing = ["Fattura (TD01)", "N. 42/2026 del 01/10/2026", "1.342,00", "MARIO ROSSI", "Bianchi & Figli S.r.l.", "Ordinario (RF01)",
    "Periodo: 01/09/2026 – 30/09/2026", "INTERNO: CONS-01", "10 ore", "−10%", "Escluse ex art. 15 (N1)", "Bonifico (MP05)",
    "IT60X0542811101000000123456", "Netto a pagare", "1.142,00", "Ritenuta persone fisiche", "copia_cortesia_42.pdf", "M5UXCR1",
    "ORD-77 del 15/08/2026 CIG Z1234ABCD", "virtuale 2,00"].filter((n) => !invoice.includes(n));
  check("fattura: tutti i dati presenti", !missing.length, missing.join(", "));
  await page.screenshot({ path: SHOTS + "03-fattura.png" });
  await page.click('.tab[data-view="xml"]');
  check("XML originale con allegati abbreviati", /caratteri omessi/.test(await page.textContent("#altView pre")));
  await page.click('.tab[data-view="invoice"]');
  await page.click(".inv-attachment button:has-text('Apri')");
  await page.waitForSelector(".page canvas");
  check("allegato PDF della fattura aperto", (await text(page, "#docTitle")) === "copia_cortesia_42.pdf" && await page.isVisible("#btnBack"));
  await page.click("#btnBack");
  await page.waitForSelector(".invoice");
  check("ritorno alla fattura", (await text(page, "#docTitle")) === "IT01234567890_00042.xml");
  await page.click("#btnPrint");
  check("stampa della fattura", (await page.evaluate(() => document.body.dataset.print)) === "alt");

  await openFixture(page, "IT01234567890_S0001.xml.p7m");
  const semp = await text(page, ".invoice");
  check("fattura semplificata", ["Fattura semplificata (TD07)", "274,50", "Lucia Bianchi"].every((n) => semp.includes(n)));

  // Altri contenuti ed errori
  await openFixture(page, "immagine.png.p7m");
  check("immagine nel p7m", (await page.$eval("#altView img", (i) => i.naturalWidth)) === 400);
  await openFixture(page, "nota.txt.p7m");
  check("testo nel p7m", (await page.textContent("#altView pre")).includes("àèìòù €"));
  await page.setInputFiles("#fileInput", FX + "doc_cifrato.pdf.p7m");
  await page.waitForSelector("#toast:not([hidden])");
  check("p7m cifrato: avviso", (await text(page, "#toast")).includes("cifrato"));
  check("nessun errore nella pagina", !errors.length, errors.join(" | "));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
