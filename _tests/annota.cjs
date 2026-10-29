// Sottolinea, Nota e «Spiega con l'AI» (con un compilatore finto); poi le annotazioni nel PDF salvato.
const fs = require("fs");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { FX, SHOTS, BASE, check, watchErrors } = require("./common.cjs");

const FAKE = "https://compilatore.prova";

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(BASE).origin });
  const page = await ctx.newPage();
  const errors = [];
  watchErrors(page, errors);
  let richiesta = null;
  await page.route(FAKE + "/**", async (route) => {
    const req = route.request();
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (req.url().endsWith("/spiega")) {
      richiesta = JSON.parse(req.postData());
      return route.fulfill({ status: 200, headers: cors, contentType: "application/json",
        body: JSON.stringify({ spiegazione: "**In parole semplici**\nÈ una riga di prova.\n- punto uno" }) });
    }
    return route.fulfill({ status: 404, headers: cors, contentType: "application/json", body: "{}" });
  });
  const drag = async (from, to) => {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    await page.mouse.move(to[0], to[1], { steps: 8 });
    await page.mouse.up();
  };
  const span = async (re) => {
    for (const s of await page.$$(".page[data-page-number='1'] .textLayer span")) if (re.test(await s.textContent())) return s.boundingBox();
    return null;
  };

  await page.goto(BASE + "#compilatore=" + encodeURIComponent(FAKE) + "&chiave=prova123");
  await page.setInputFiles("#fileInput", FX + "doc.pdf");
  await page.waitForSelector(".page[data-page-number='1'] .textLayer span");
  await page.waitForTimeout(500);
  const r1 = await span(/Riga 1/);
  check("riga di prova trovata", !!r1);

  // --- Selezione col mouse → pulsantino con Copia · Sottolinea · Spiega
  await drag([r1.x + 1, r1.y + r1.height / 2], [r1.x + r1.width - 1, r1.y + r1.height / 2]);
  await page.waitForSelector(".copy-pill:not([hidden])");
  const voci = await page.$$eval(".copy-pill button:not([hidden])", (b) => b.map((x) => x.textContent));
  check("pulsantino: Copia, Sottolinea, Spiega", voci.join(",") === "Copia,Sottolinea,Spiega", voci.join(","));
  await page.click(".copy-pill [data-a='sottolinea']");
  await page.waitForTimeout(400);
  const segni = await page.$$eval(".page[data-page-number='1'] svg.highlight", (e) => e.length);
  check("sottolineatura disegnata", segni > 0, `${segni} elementi`);
  // La striscia sta sotto la riga, non sopra il testo.
  const bb = await page.evaluate(() => {
    const s = document.querySelector(".page[data-page-number='1'] svg.highlight");
    return s ? s.getBoundingClientRect().toJSON() : null;
  });
  check("striscia sottile sotto la riga", bb && bb.height < r1.height * 0.4 && bb.y > r1.y + r1.height * 0.5,
    bb ? `y ${bb.y.toFixed(0)} h ${bb.height.toFixed(1)}; riga y ${r1.y.toFixed(0)} h ${r1.height.toFixed(1)}` : "nessuna");

  // --- Spiega dal pulsantino
  const r2 = await span(/Riga 2/);
  await drag([r2.x + 1, r2.y + r2.height / 2], [r2.x + r2.width - 1, r2.y + r2.height / 2]);
  await page.waitForSelector(".copy-pill:not([hidden])");
  await page.click(".copy-pill [data-a='spiega']");
  await page.waitForSelector("#sumPanel:not([hidden])");
  check("al compilatore il testo selezionato e la pagina", richiesta && /Riga 2/.test(richiesta.testo) && /Riga 1/.test(richiesta.contesto),
    richiesta ? JSON.stringify(richiesta.testo) : "nessuna richiesta");
  check("pannello «Spiegazione»", (await page.textContent("#sumTitle")) === "Spiegazione" && /parole semplici/.test(await page.textContent("#sumBody")));
  await page.click("#sumClose");

  // --- Spiega uno screenshot: va un'immagine
  richiesta = null;
  await page.click("#btnShot");
  const pb = await (await page.$(".page[data-page-number='1'] canvas")).boundingBox();
  await drag([pb.x + 40, pb.y + 40], [pb.x + 300, pb.y + 160]);
  await page.waitForSelector(".copy-card.shot:not([hidden])");
  check("nello screenshot niente «Sottolinea»", await page.isHidden(".copy-card [data-a='sottolinea']"));
  await page.click(".copy-card [data-a='spiega']");
  await page.waitForSelector("#sumPanel:not([hidden])");
  check("al compilatore l'immagine del ritaglio", richiesta && richiesta.png && Buffer.from(richiesta.png, "base64").subarray(1, 4).toString() === "PNG");
  await page.click("#sumClose");
  await page.keyboard.press("Escape");

  // --- Pulsante Sottolinea: modalità, poi riquadro
  await page.click("#btnUnderline");
  check("modalità sottolinea accesa", (await page.getAttribute("#btnUnderline", "aria-pressed")) === "true");
  await page.click("#btnBox");
  const r3 = await span(/Riga 3/);
  await drag([r3.x - 4, r3.y - 2], [r3.x + r3.width + 4, r3.y + r3.height + 2]);
  await page.waitForTimeout(400);
  const segni2 = await page.$$eval(".page[data-page-number='1'] svg.highlight", (e) => e.length);
  check("sottolineatura anche col riquadro", segni2 > segni, `${segni2} contro ${segni}`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  check("Esc spegne la modalità", (await page.getAttribute("#btnUnderline", "aria-pressed")) === "false");

  // --- Nota: clic sulla pagina, si scrive
  await page.click("#btnNote");
  check("barra della nota", await page.isVisible("#signBar") && /nota/.test(await page.textContent("#signBarText")));
  await page.mouse.click(pb.x + pb.width * 0.6, pb.y + pb.height * 0.5);
  await page.waitForSelector(".freeTextEditor .internal");
  await page.keyboard.type("Nota di prova CARTA");
  await page.click("#signDone");
  await page.waitForTimeout(400);
  await page.screenshot({ path: SHOTS + "50-annotazioni.png" });

  // --- Salvataggio: annotazioni nel PDF
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#btnDownload")]);
  const out = SHOTS + "annotato.pdf";
  await dl.saveAs(out);
  const info = execFileSync("python", ["-c", `
import sys
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
for a in r.pages[0].get("/Annots") or []:
    a = a.get_object()
    print(a.get("/Subtype"), repr(a.get("/Contents")), a.get("/C"))
`, out], { encoding: "utf-8" });
  console.log(info.trim());
  check("nel PDF le sottolineature", (info.match(/\/Highlight/g) || []).length >= 2);
  check("nel PDF la nota", /\/FreeText 'Nota di prova CARTA'/.test(info));

  check("nessun errore nella pagina", errors.length === 0, errors.join(" | "));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
