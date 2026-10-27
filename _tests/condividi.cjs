// Pulsante Condividi con la Web Share API simulata in tre configurazioni.
const { chromium } = require("playwright");
const { BASE, check, watchErrors, openFixture, text } = require("./common.cjs");

// "all": condivide ogni file; "chrome": solo i tipi ammessi da Chrome; "none": nessuna Web Share.
function stub(mode) {
  window.__shared = [];
  if (mode === "none") {
    delete Navigator.prototype.share;
    delete Navigator.prototype.canShare;
    return;
  }
  const allowed = /\.(pdf|png|jpe?g|gif|webp|txt|csv)$/i;
  navigator.canShare = (d) => !d.files || d.files.every((f) => mode === "all" || allowed.test(f.name));
  navigator.share = async (d) => { window.__shared.push({ url: d.url, files: (d.files || []).map((f) => f.name) }); };
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const open = async (mode) => {
    const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], acceptDownloads: true, serviceWorkers: "block" });
    await ctx.addInitScript(stub, mode);
    const page = await ctx.newPage();
    watchErrors(page, errors);
    await page.goto(BASE);
    return page;
  };
  const last = (p) => p.evaluate(() => window.__shared[window.__shared.length - 1]);

  let p = await open("all");
  await p.click("#btnShare");
  check("senza documento condivide il link", ((await last(p)) || {}).url === BASE);
  await openFixture(p, "doc.pdf.p7m");
  await p.click("#btnShare");
  check("p7m: menu con due scelte", (await p.$$(".share-option")).length === 2);
  await p.click(".share-option:has-text('File firmato originale')");
  check("condivide il p7m originale", ((await last(p)) || {}).files?.[0] === "doc.pdf.p7m");
  await p.click("#btnShare");
  await p.keyboard.press("Escape");
  check("Esc chiude il menu", await p.isHidden("#shareMenu"));

  p = await open("chrome");
  await openFixture(p, "doc.pdf.p7m");
  await p.click("#btnShare");
  check("tipi di Chrome: condivide subito il PDF", ((await last(p)) || {}).files?.[0] === "doc.pdf");
  await openFixture(p, "IT01234567890_00042.xml.p7m");
  const [dl] = await Promise.all([p.waitForEvent("download"), p.click("#btnShare")]);
  check("XML non condivisibile: salvato con avviso", dl.suggestedFilename() === "IT01234567890_00042.xml" && (await text(p, "#toast")).includes("salvato"));

  p = await open("none");
  await p.click("#btnShare");
  await p.waitForSelector("#toast:not([hidden])");
  check("senza Web Share copia il link", (await p.evaluate(() => navigator.clipboard.readText())) === BASE);
  check("nessun errore nella pagina", !errors.length, errors.join(" | "));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
