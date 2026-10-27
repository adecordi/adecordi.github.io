// Telefono, tema scuro e uso offline con il service worker.
const { chromium, devices } = require("playwright");
const { SHOTS, BASE, check, watchErrors, openFixture, text } = require("./common.cjs");

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  const phone = await browser.newContext({ ...devices["iPhone 13"], serviceWorkers: "block" });
  const p = await phone.newPage();
  watchErrors(p, errors);
  await p.goto(BASE);
  await openFixture(p, "doc_scaduto.pdf.p7m");
  await p.waitForSelector(".page canvas");
  check("telefono: zoom a larghezza pagina", (await p.$eval("#zoomSelect", (s) => s.value)) === "page-width");
  check("telefono: certificato scaduto segnalato", (await text(p, "#sigChip")) === "Certificato scaduto");
  check("telefono: niente scorrimento orizzontale", !(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  await p.screenshot({ path: SHOTS + "10-telefono.png" });
  await phone.close();

  const dark = await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: "dark" });
  const d = await dark.newPage();
  watchErrors(d, errors);
  await d.goto(BASE);
  await d.evaluate(() => navigator.serviceWorker.ready);
  await d.reload();
  await d.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
  check("service worker attivo", true);
  await d.screenshot({ path: SHOTS + "11-scuro.png" });
  await dark.setOffline(true);
  await d.reload();
  await openFixture(d, "doc.pdf.tsd");
  await d.waitForSelector(".page canvas", { timeout: 15000 });
  check("offline: apre un .tsd", (await text(d, "#sigChip")) === "Firmato da Mario Rossi");
  await dark.setOffline(false);
  await dark.close();
  check("nessun errore nella pagina", !errors.filter((e) => !e.includes("ERR_INTERNET_DISCONNECTED")).length, errors.join(" | "));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
