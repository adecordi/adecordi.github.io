// Stampa di 40 pagine (rendering) e stampa nativa con il visualizzatore PDF di Chromium.
const { chromium } = require("playwright");
const { FX, SHOTS, BASE, check, openFixture } = require("./common.cjs");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints++; }; });
  await page.goto(BASE);
  await openFixture(page, "grande.pdf.p7m");
  await page.waitForSelector(".page canvas");
  const t = Date.now();
  await page.click("#btnPrint");
  await page.waitForFunction(() => window.__prints > 0, null, { timeout: 120000 });
  const pages = await page.$$eval("#printContainer .printedPage :is(canvas,img)", (a) => a.length);
  check("40 pagine preparate per la stampa", pages === 40, `${Date.now() - t} ms`);
  await page.emulateMedia({ media: "print" });
  await page.pdf({ path: SHOTS + "stampa-40-pagine.pdf", preferCSSPageSize: true });
  await browser.close();

  // Chromium completo ha il visualizzatore PDF integrato: si usa la stampa nativa.
  let full;
  try {
    full = await chromium.launch({ channel: "chromium" });
  } catch {
    console.log("– stampa nativa non verificata: Chromium completo non installato");
    return;
  }
  const p = await full.newPage();
  await p.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints++; }; });
  await p.goto(BASE);
  if (!(await p.evaluate(() => navigator.pdfViewerEnabled))) {
    console.log("– stampa nativa non verificata: visualizzatore PDF non disponibile");
  } else {
    await openFixture(p, "grande.pdf.p7m");
    await p.waitForSelector(".page canvas");
    await p.click("#btnPrint");
    await p.waitForSelector("iframe.print-frame", { state: "attached", timeout: 10000 });
    await p.waitForTimeout(1500);
    check("stampa nativa con il visualizzatore integrato",
      p.frames().some((f) => f.url().startsWith("chrome-extension://")) && (await p.evaluate(() => window.__prints)) === 0);
    await p.click("#btnRotate");
    await p.click("#btnPrint");
    await p.waitForFunction(() => window.__prints > 0, null, { timeout: 120000 });
    check("pagine ruotate: si usa il rendering", true);
  }
  await full.close();
})().catch((e) => { console.error(e); process.exit(1); });
