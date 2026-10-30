// Nitidezza: dopo lo zoom del browser (cambia la densità dei pixel) le pagine si ridisegnano, non si sgranano
// (30/10/2026). E una scansione raddrizzata resta dritta dopo il ridisegno.
const { chromium } = require("playwright");
const path = require("path");
const { BASE, check, watchErrors } = require("./common.cjs");

const SCANSIONE = path.join(__dirname, "..", "pdf", "esempi", "modulo-di-prova-scansionato.pdf");

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  watchErrors(page, errors);
  await page.goto(BASE);
  await page.setInputFiles("#fileInput", SCANSIONE);
  await page.waitForSelector(".page[data-page-number='1'] canvas");
  await page.waitForTimeout(1500);
  const densita = () => page.$eval(".page[data-page-number='1'] canvas", (c) => c.width / c.getBoundingClientRect().width);
  check("pixel giusti all'apertura", Math.abs((await densita()) - 1) < 0.05);
  await page.click("#btnRotate");
  await page.waitForFunction(() => /raddrizzat/.test(document.getElementById("toast").textContent), null, { timeout: 30000 });
  // lo zoom del browser: cambiano insieme densità e larghezza in pixel CSS
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 1000, deviceScaleFactor: 2, mobile: false });
  await page.waitForTimeout(2500);
  const d = await densita();
  check("dopo lo zoom del browser si ridisegna a densità 2", Math.abs(d - 2) < 0.05, d.toFixed(2));
  check("la scansione resta raddrizzata", /rotate\(/.test(await page.$eval(".page[data-page-number='1']", (p) => p.style.transform)));
  check("nessun errore nella pagina", errors.length === 0, errors.join(" | "));
  await b.close();
})();
