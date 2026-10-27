// Prestazioni con rete 4G simulata (500 KB/s, 80 ms) e CPU rallentata 4 volte, cache vuota.
// Uso: node perf.cjs [ripetizioni]   (con il server avviato: node server.cjs)
const { chromium } = require("playwright");
const { FX, BASE } = require("./common.cjs");

const RUNS = +process.argv[2] || 3;
const median = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function run(browser, waitBeforeOpen) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 80, downloadThroughput: 500 * 1024, uploadThroughput: 375 * 1024 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.addInitScript(() => { window.__prints = 0; window.print = () => { window.__prints++; }; });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const ready = await page.evaluate(() => performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd);
  if (waitBeforeOpen) await page.waitForTimeout(waitBeforeOpen);
  let t = Date.now();
  await page.setInputFiles("#fileInput", FX + "grande.pdf.p7m");
  await page.waitForSelector(".page canvas", { timeout: 60000 });
  const open = Date.now() - t;
  await page.waitForTimeout(300);
  t = Date.now();
  await page.click("#btnPrint");
  await page.waitForFunction(() => window.__prints > 0, null, { timeout: 180000 });
  const print = Date.now() - t;
  await ctx.close();
  return { ready, open, print };
}

(async () => {
  const browser = await chromium.launch();
  for (const wait of [0, 3000]) {
    const results = [];
    for (let i = 0; i < RUNS; i++) results.push(await run(browser, wait));
    const m = (k) => Math.round(median(results.map((r) => r[k])));
    console.log(`apertura dopo ${wait} ms -> app pronta ${m("ready")} ms | primo render p7m 40 pagine ${m("open")} ms | stampa pronta ${m("print")} ms`);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
