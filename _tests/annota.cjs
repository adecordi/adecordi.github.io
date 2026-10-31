// Selezione (testo o riquadro) e menu: Copia, Sottolinea, Evidenzia, Traduci, Spiega, Immagine; Nota;
// pannello accanto al PDF; annotazioni nel PDF salvato. Compilatore finto.
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const { FX, SHOTS, BASE, check, watchErrors } = require("./common.cjs");

const FAKE = "https://compilatore.prova";

(async () => {
  const browser = await chromium.launch();
  try {
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
        const testo = richiesta.compito === "traduci" ? "Row 2: supply contract." : "**In parole semplici**\nÈ una riga di prova.\n- punto uno";
        return route.fulfill({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ spiegazione: testo }) });
      }
      return route.fulfill({ status: 404, headers: cors, contentType: "application/json", body: "{}" });
    });
    const drag = async (from, to) => {
      await page.mouse.move(from[0], from[1]);
      await page.mouse.down();
      await page.mouse.move(to[0], to[1], { steps: 8 });
      await page.mouse.up();
    };
    // Dopo un cambio di spazio (pannello aperto o chiuso) la pagina si ridisegna: si aspetta il testo nuovo.
    const span = async (re) => {
      for (let i = 0; i < 40; i++) {
        for (const s of await page.$$(".page[data-page-number='1'] .textLayer span")) {
          if (re.test(await s.textContent())) { const bb = await s.boundingBox(); if (bb) return bb; }
        }
        await page.waitForTimeout(150);
      }
      return null;
    };
    const seleziona = async (re) => {
      const r = await span(re);
      await drag([r.x + 1, r.y + r.height / 2], [r.x + r.width - 1, r.y + r.height / 2]);
      await page.waitForSelector(".copy-pill:not([hidden])");
      return r;
    };
    const voci = () => page.$$eval(".copy-pill button:not([hidden])", (b) => b.map((x) => x.textContent).join(","));
    const strisce = () => page.$$eval(".page[data-page-number='1'] svg.highlight", (e) => e.length);

    await page.goto(BASE + "#compilatore=" + encodeURIComponent(FAKE) + "&chiave=prova123");
    await page.setInputFiles("#fileInput", FX + "doc.pdf");
    await page.waitForSelector(".page[data-page-number='1'] .textLayer span");
    await page.waitForTimeout(500);
    check("modo «testo» acceso all'inizio", (await page.getAttribute("#btnSelText", "aria-pressed")) === "true");
    check("niente pulsanti Screenshot e Sottolinea nella barra", !(await page.$("#btnShot")) && !(await page.$("#btnUnderline")));

    // --- Testo: menu con le cinque voci
    const r1 = await seleziona(/Riga 1/);
    check("menu del testo: Copia, Sottolinea, Evidenzia, Traduci, Spiega, Leggi", (await voci()) === "Copia,Sottolinea,Evidenzia,Traduci,Spiega,Leggi", await voci());
    await page.click(".copy-pill [data-a='sottolinea']");
    await page.waitForTimeout(400);
    check("sottolineatura disegnata", (await strisce()) === 1);
    const bb = await page.evaluate(() => document.querySelector(".page[data-page-number='1'] svg.highlight").getBoundingClientRect().toJSON());
    check("striscia sottile sotto la riga", bb.height < r1.height * 0.4 && bb.y > r1.y + r1.height * 0.5,
      `y ${bb.y.toFixed(0)} h ${bb.height.toFixed(1)}; riga y ${r1.y.toFixed(0)} h ${r1.height.toFixed(1)}`);

    await seleziona(/Riga 2/);
    await page.click(".copy-pill [data-a='evidenzia']");
    await page.waitForTimeout(400);
    check("evidenziazione disegnata", (await strisce()) === 2);

    // --- Spiega: pannello accanto al PDF
    await seleziona(/Riga 3/);
    await page.click(".copy-pill [data-a='spiega']");
    await page.waitForSelector("#sumPanel:not([hidden])");
    check("al compilatore il testo e la pagina", richiesta && /Riga 3/.test(richiesta.testo) && /Riga 1/.test(richiesta.contesto) && richiesta.compito === "spiega");
    check("pannello «Spiegazione»", (await page.textContent("#sumTitle")) === "Spiegazione");
    await page.waitForTimeout(500);
    const vc = await (await page.$("#viewerContainer")).boundingBox();
    const pn = await (await page.$("#sumPanel")).boundingBox();
    check("il PDF resta visibile accanto al pannello", vc.x + vc.width <= pn.x + 1, `PDF fino a ${Math.round(vc.x + vc.width)}, pannello da ${Math.round(pn.x)}`);
    await page.click("#sumClose");
    await page.waitForTimeout(600);

    // --- Traduci
    await seleziona(/Riga 4/);
    await page.click(".copy-pill [data-a='traduci']");
    await page.waitForSelector("#sumPanel:not([hidden])");
    check("traduzione: compito «traduci» e pannello «Traduzione»", richiesta.compito === "traduci" && (await page.textContent("#sumTitle")) === "Traduzione");
    await page.click("#sumClose");
    await page.waitForTimeout(600);

    // --- Copia
    await seleziona(/Riga 5/);
    await page.click(".copy-pill [data-a='copia']");
    await page.waitForTimeout(200);
    const clip = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n");
    check("Copia mette il testo negli appunti", /Riga 5/.test(clip), JSON.stringify(clip));
    await page.keyboard.press("Escape");

    // --- Riquadro: stesso menu, più Immagine; niente copia automatica
    await page.evaluate(() => navigator.clipboard.writeText("vuoto"));
    await page.click("#btnBox");
    check("modo «riquadro» acceso", (await page.getAttribute("#btnBox", "aria-pressed")) === "true" && (await page.getAttribute("#btnSelText", "aria-pressed")) === "false");
    const r6 = await span(/Riga 6/);
    await drag([r6.x - 4, r6.y - 2], [r6.x + r6.width + 4, r6.y + r6.height + 2]);
    await page.waitForSelector(".copy-pill:not([hidden])");
    check("menu del riquadro: + Immagine", (await voci()) === "Copia,Sottolinea,Evidenzia,Traduci,Spiega,Leggi,Immagine", await voci());
    check("il riquadro non copia da solo", (await page.evaluate(() => navigator.clipboard.readText())) === "vuoto");
    await page.click(".copy-pill [data-a='sottolinea']");
    await page.waitForTimeout(400);
    check("sottolineatura anche col riquadro", (await strisce()) === 3);
    const pb = await (await page.$(".page[data-page-number='1']")).boundingBox();
    await drag([pb.x + 40, pb.y + 40], [pb.x + 300, pb.y + 160]);
    await page.waitForSelector(".copy-pill:not([hidden])");
    await page.click(".copy-pill [data-a='immagine']");
    await page.waitForSelector(".copy-card.shot:not([hidden])");
    check("Immagine: screenshot del riquadro", await page.isVisible(".copy-card.shot img"));
    await page.keyboard.press("Escape");
    await page.click("#btnSelText");

    // --- Nota
    await page.click("#btnNote");
    check("barra della nota", await page.isVisible("#signBar") && /nota/.test(await page.textContent("#signBarText")));
    const pb2 = await (await page.$(".page[data-page-number='1']")).boundingBox();
    await page.mouse.click(pb2.x + pb2.width * 0.6, pb2.y + pb2.height * 0.5);
    await page.waitForSelector(".freeTextEditor .internal");
    await page.keyboard.type("Nota di prova CARTA");
    await page.click("#signDone");
    await page.waitForTimeout(400);
    await page.screenshot({ path: SHOTS + "50-annotazioni.png" });

    // --- Salvataggio
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#btnDownload")]);
    const out = SHOTS + "annotato.pdf";
    await dl.saveAs(out);
    const info = execFileSync("python", ["-c", `
import sys
from pypdf import PdfReader
for a in PdfReader(sys.argv[1]).pages[0].get("/Annots") or []:
    a = a.get_object()
    c = a.get("/C")
    print(a.get("/Subtype"), repr(a.get("/Contents")), [round(float(x), 2) for x in c] if c else None, a.get("/DA"))
`, out], { encoding: "utf-8" });
    console.log(info.trim());
    check("nel PDF sottolineature rosse", (info.match(/\/Highlight None \[0\.64, 0\.09, 0\.1\]/g) || []).length === 2);
    check("nel PDF l'evidenziazione gialla", /\/Highlight None \[1\.0, 0\.88, 0\.42\]/.test(info));
    check("nel PDF la nota rossa", /\/FreeText 'Nota di prova CARTA'.*0\.64 0\.09 0\.1 rg/.test(info));
    check("nessun errore nella pagina", errors.length === 0, errors.join(" | "));
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
