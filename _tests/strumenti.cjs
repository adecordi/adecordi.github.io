// OCR delle scansioni, selezione continua e a riquadro, firma, compilazione (con un compilatore finto).
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { FX, SHOTS, BASE, check, watchErrors } = require("./common.cjs");

const FAKE = "https://compilatore.prova";

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const origin = new URL(BASE).origin;
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await ctx.newPage();
  const errors = [];
  watchErrors(page, errors);
  // Su Windows gli appunti restituiscono gli a capo come \r\n.
  const clipboard = async () => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
  const drag = async (from, to) => {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    await page.mouse.move(to[0], to[1], { steps: 8 });
    await page.mouse.up();
  };

  // --- OCR di una pagina fatta solo di immagine
  await page.goto(BASE);
  check("senza collegamento niente «Compila»", await page.isHidden("#btnFill"));
  await page.setInputFiles("#fileInput", FX + "scansione.pdf");
  const t0 = Date.now();
  await page.waitForSelector(".page[data-page-number='1'] .ocrLayer span", { timeout: 120000 });
  const ocr = await page.$eval(".page[data-page-number='1'] .ocrLayer", (l) => l.textContent);
  check("OCR della scansione", /Modulo scansionato di prova/.test(ocr) && /Sinistra 3 alfa/.test(ocr) && /Destra 8 omega/.test(ocr),
    `${Date.now() - t0} ms`);

  // --- Selezione continua col mouse: a fine riga va a capo
  const spans = await page.$$(".page[data-page-number='1'] .ocrLayer span");
  const find = async (re) => {
    for (const s of spans) if (re.test(await s.textContent())) return s.boundingBox();
    return null;
  };
  // Tesseract mette le due colonne nella stessa riga: «Sinistra 1 alfa Destra 1 omega».
  const s1 = await find(/^Sinistra 1/);
  const s3 = await find(/^Sinistra 3/);
  await drag([s1.x + 2, s1.y + s1.height / 2], [s3.x + s3.width - 2, s3.y + s3.height / 2]);
  const sel = await page.evaluate(() => getSelection().toString());
  check("selezione continua su più righe", sel.includes("Sinistra 1") && sel.includes("Destra 3") && sel.includes("\n"),
    JSON.stringify(sel.slice(0, 80)));
  await page.evaluate(() => getSelection().removeAllRanges());

  // --- Selezione a riquadro: solo la colonna di sinistra, righe 1-3
  await page.click("#btnBox");
  check("pulsante riquadro attivo", (await page.getAttribute("#btnBox", "aria-pressed")) === "true");
  // Colonna di sinistra: nell'immagine va da 120 a ~420 px su 1240 di larghezza.
  const pb0 = await (await page.$(".page[data-page-number='1'] canvas")).boundingBox();
  await drag([s1.x - 6, s1.y - 4], [pb0.x + pb0.width * 0.45, s3.y + s3.height + 4]);
  // Dal 29/10/2026 il riquadro apre il menu: si copia con «Copia».
  await page.waitForSelector(".copy-pill:not([hidden])");
  await page.click(".copy-pill [data-a='copia']");
  await page.waitForTimeout(200);
  const col = await clipboard();
  check("riquadro: solo la colonna scelta", col === "Sinistra 1 alfa\nSinistra 2 alfa\nSinistra 3 alfa", JSON.stringify(col));
  check("riquadro visibile", await page.isVisible(".boxSel"));
  check("parole prese colorate", (await page.$$(".boxMark")).length >= 3);
  check("pannello col testo copiato", await page.isVisible(".copy-card")
    && (await page.textContent(".copy-card pre")) === "Sinistra 1 alfa\nSinistra 2 alfa\nSinistra 3 alfa");
  await page.screenshot({ path: SHOTS + "40-riquadro.png" });
  await page.keyboard.press("Escape");
  check("Esc chiude il riquadro", (await page.getAttribute("#btnBox", "aria-pressed")) === "false" && !(await page.$(".boxSel")));
  check("Esc chiude anche il pannello", await page.isHidden(".copy-card"));

  // --- OCR a richiesta, sul dispositivo (due passate)
  await page.click("#btnOcr");
  check("menu OCR: server e AI spenti senza compilatore", await page.isDisabled("#ocrMenu button:nth-child(2)") && await page.isDisabled("#ocrMenu button:nth-child(3)"));
  await page.click("#ocrMenu button:nth-child(1)");
  await page.waitForFunction(() => /riconosciute/.test(document.getElementById("toast").textContent), null, { timeout: 120000 });
  check("OCR sul dispositivo a richiesta", /Pagina 1: \d+ righe/.test(await page.textContent("#toast")), await page.textContent("#toast"));

  // --- Firma disegnata, inserita, salvata nel PDF
  await page.click("#btnSign");
  await page.waitForSelector(".sign-dialog[open]");
  const pad = await (await page.$(".sign-pad")).boundingBox();
  await page.mouse.move(pad.x + 30, pad.y + pad.height * 0.6);
  await page.mouse.down();
  for (let i = 0; i <= 25; i++) await page.mouse.move(pad.x + 30 + i * 14, pad.y + pad.height * (0.6 - 0.3 * Math.sin(i / 3)));
  await page.mouse.up();
  await page.check("#signKeep");
  await page.click(".sign-dialog .btn.primary");
  const stamp = await page.waitForSelector(".stampEditor canvas", { timeout: 10000 });
  await page.waitForTimeout(500);
  const sb = await stamp.boundingBox();
  const pb = await (await page.$(".page[data-page-number='1']")).boundingBox();
  check("firma di misura ragionevole", sb.width < pb.width * 0.4 && sb.width > pb.width * 0.15, `${Math.round(sb.width)} su ${Math.round(pb.width)} px`);
  check("barra «Fatto» visibile", await page.isVisible("#signBar"));
  await page.screenshot({ path: SHOTS + "41-firma.png" });
  await page.click("#signDone");
  check("dopo «Fatto» la firma resta", !(await page.isVisible("#signBar")) && (await page.$$(".stampEditor")).length === 1);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#btnDownload")]);
  const saved = fs.readFileSync(await dl.path()).toString("latin1");
  check("firma salvata nel PDF", /\/Subtype\s*\/Stamp/.test(saved));
  check("firma ricordata sul dispositivo", await page.evaluate(() => !!localStorage.getItem("lettore-firma")));
  await page.click("#btnSign");
  await page.waitForSelector(".sign-dialog[open]");
  check("firma salvata proposta per prima", (await page.getAttribute(".sign-saved-pick", "aria-pressed")) === "true"
    && await page.isVisible(".sign-dialog .sign-pad") && await page.isVisible(".sign-dialog .sign-typed"));
  await page.keyboard.press("Escape");
  check("Esc chiude la finestra della firma", !(await page.$(".sign-dialog[open]")));

  // --- Riquadro sul testo vero di un PDF (Alt + trascina, senza pulsante)
  await page.setInputFiles("#fileInput", FX + "doc.pdf");
  await page.waitForSelector(".page[data-page-number='1'] .textLayer span");
  await page.waitForTimeout(500);
  const r1 = await page.$$eval(".page[data-page-number='1'] .textLayer span", (els) => {
    const s = els.filter((e) => /^Riga [12]:/.test(e.textContent)).map((e) => e.getBoundingClientRect());
    return s.map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height }));
  });
  await page.keyboard.down("Alt");
  await drag([r1[0].x - 4, r1[0].y - 3], [r1[0].x + r1[0].w * 0.2, r1[1].y + r1[1].h + 3]);
  await page.keyboard.up("Alt");
  await page.waitForSelector(".copy-pill:not([hidden])");
  await page.click(".copy-pill [data-a='copia']");
  await page.waitForTimeout(200);
  check("Alt + trascina sul testo vero", /^Riga 1: ?c\S*\nRiga 2: ?c\S*$/.test(await clipboard()), JSON.stringify(await clipboard()));

  // --- Compilazione con un compilatore finto
  let request = null;
  let cercato = null;
  const richieste = [];
  let riassunto = null;
  let ricordato = null;
  const MODULO = path.join(__dirname, "..", "pdf", "esempi", "conto-corrente-dedicato.pdf");
  await page.route(FAKE + "/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
    if (req.url().endsWith("/riassumi")) {
      riassunto = JSON.parse(req.postData());
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ riassunto: "**In breve**\nDocumento di prova.\n**Punti principali**\n- tre pagine (p. 1)\n- righe ripetute" }),
      });
    }
    if (req.url().endsWith("/cerca")) {
      cercato = JSON.parse(req.postData());
      return route.fulfill({ status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ trovato: true, valore: "CR-28313", fonte: "visura del 17/09/2026", certezza: "alta", nota: "" }) });
    }
    if (req.url().endsWith("/ricorda")) {
      ricordato = JSON.parse(req.postData());
      return route.fulfill({ status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ voce: "SCHEDA_AGGIUNTE_AZIENDA", aggiunti: ricordato.dati.length }) });
    }
    richieste.push(JSON.parse(req.postData()));
    request = { auth: req.headers().authorization, body: JSON.parse(req.postData()) };
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        pdf: fs.readFileSync(MODULO).toString("base64"),
        metodo: "campi",
        avvisi: ["IBAN cambiato nella cassaforte aziendale (visto il 30/10/2026): prima IT60…3456 → ora IT60…9999."],
        compilati: [{ campo: "Cognome", valore: "ROSSI", pagina: 1 }],
        mancanti: [{ campo: "Firma", motivo: "da fare a mano" }, { campo: "Numero REA", motivo: "non nelle fonti" },
          { campo: "Banca", motivo: "non nelle fonti", pdf_campo: "p1_c06_Banca", tipo: "testo" },
          { campo: "Delegato 1", motivo: "non nelle fonti", pdf_campo: "p1_c16_Cognome e nome (riga 1)", tipo: "testo" },
          { campo: "Conto per tutte le commesse", motivo: "scelta", pdf_campo: "p1_c14_CASELLA a tutte le commesse pubbliche", tipo: "casella" }],
      }),
    });
  });
  await page.goto("about:blank"); // solo il frammento diverso non ricaricherebbe la pagina
  await page.goto(BASE + "#compilatore=" + encodeURIComponent(FAKE) + "&chiave=prova123");
  check("collegamento dal link", (await page.textContent("#toast")).includes("Compilatore collegato") && !page.url().includes("chiave"));
  await page.setInputFiles("#fileInput", FX + "doc.pdf");
  await page.waitForSelector(".page canvas");
  check("«Compila» visibile dopo il collegamento", await page.isVisible("#btnFill"));
  await page.click("#btnFill");
  // Alessandro senza cassaforte aziendale: «Usa quelli della VM»
  await page.click(".cf-dialog button[value=salta]");
  check("«A nome di chi?» obbligatorio", await page.$eval("input[name=fillWho]", (i) => i.required));
  await page.check("input[name=fillWho][value=azienda]");
  await page.fill("#fillNotes", "per la Vinicola");
  await page.click(".fill-dialog .btn.primary");
  await page.waitForSelector("#fillPanel:not([hidden])", { timeout: 10000 });
  check("richiesta con chiave e istruzioni", request && request.auth === "Bearer prova123" && request.body.istruzioni === "per la Vinicola" && request.body.profilo === "azienda" && request.body.pdf.length > 100);
  check("si apre il modulo compilato", (await page.textContent("#docTitle")) === "doc (compilato).pdf");
  // Dati mancanti: «Firma ora» per la firma, «Lo scrivo io» / «Cercalo» per il resto
  check("firma: «Firma ora»", (await page.textContent("#fillBody")).includes("Firma ora"));
  check("avviso sui dati della Vinicola cambiati", (await page.textContent("#fillBody .fill-avviso")).includes("IBAN cambiato"));
  const voceRea = page.locator("#fillBody li", { hasText: "Numero REA" });
  await voceRea.locator("button", { hasText: "Cercalo" }).click();
  await voceRea.locator(".fill-value").waitFor({ timeout: 10000 });
  check("Cercalo: valore e fonte", (await voceRea.textContent()).includes("CR-28313") && (await voceRea.textContent()).includes("visura")
    && cercato && cercato.campo === "Numero REA" && cercato.profilo === "azienda");
  // Con il campo noto: «Inserisci» lo scrive subito nel modulo, senza ricompilare
  const campoVale = (v) => page.evaluate((v) => [...document.querySelectorAll(".annotationLayer input")].some((i) => i.value === v), v);
  const voceBanca = page.locator("#fillBody li", { hasText: "Banca" });
  await voceBanca.locator("button", { hasText: "Cercalo" }).click();
  await voceBanca.locator(".fill-value").waitFor({ timeout: 10000 });
  await voceBanca.locator(".fill-found button", { hasText: "Inserisci" }).click();
  await voceBanca.locator(".fill-ok").waitFor({ timeout: 5000 });
  check("Cercalo → Inserisci: subito nel campo, senza ricompilare", await campoVale("CR-28313") && richieste.length === 1);
  const voceDel = page.locator("#fillBody li", { hasText: "Delegato 1" });
  await voceDel.locator("button", { hasText: "Lo scrivo io" }).click();
  await voceDel.locator("input").fill("Mario Rossi");
  await voceDel.locator(".fill-scrivi button", { hasText: "Inserisci" }).click();
  await voceDel.locator(".fill-ok").waitFor({ timeout: 5000 });
  check("Lo scrivo io → Inserisci: nel campo", await campoVale("Mario Rossi"));
  await page.locator("#fillBody li", { hasText: "Conto per tutte" }).locator("button", { hasText: "Spunta" }).click();
  await page.waitForTimeout(300);
  check("Spunta: la casella del modulo", await page.evaluate(() => [...document.querySelectorAll(".annotationLayer input[type=checkbox]")].some((i) => i.checked)));
  check("chiede se salvare in cassaforte", (await page.textContent(".fill-salva")).includes("2 dati"));
  await page.click(".fill-salva button:has-text('Sì, salvali')");
  await page.waitForFunction(() => /Salvati/.test(document.querySelector(".fill-salva").textContent));
  check("in cassaforte i due dati inseriti", ricordato && ricordato.dati.length === 2 && ricordato.profilo === "azienda"
    && ricordato.dati.some((d) => d.valore === "Mario Rossi"), JSON.stringify(ricordato));
  // Senza campo noto: si ricompila subito con quel dato
  await voceRea.locator(".fill-found button", { hasText: "Inserisci" }).click();
  await page.waitForFunction(() => document.getElementById("busy").hidden);
  await page.waitForTimeout(500);
  check("ricompilato col dato trovato", richieste.length === 2 && richieste[1].istruzioni.includes("Numero REA: CR-28313")
    && richieste[1].profilo === "azienda", richieste.length ? JSON.stringify(richieste[richieste.length - 1].istruzioni) : "");
  const report = await page.textContent("#fillBody");
  check("riepilogo: compilati e da fare", report.includes("ROSSI") && report.includes("Da completare") && report.includes("Firma"));
  await page.screenshot({ path: SHOTS + "42-compilato.png" });

  // --- Riassumi (stesso compilatore finto)
  check("«Riassumi» visibile", await page.isVisible("#btnSum"));
  await page.click("#btnSum");
  await page.waitForSelector("#sumPanel:not([hidden])", { timeout: 10000 });
  check("al compilatore il testo di ogni pagina", riassunto && riassunto.pagine.length === 1 && riassunto.pagine[0].includes("CONTO CORRENTE DEDICATO"));
  check("riassunto in elenco, non a colonne", (await page.$$("#sumBody .riassunto li")).length === 2
    && (await page.$eval("#sumBody .riassunto", (el) => getComputedStyle(el).display)) === "block");

  check("nessun errore nella pagina", errors.length === 0, errors.join(" | "));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
