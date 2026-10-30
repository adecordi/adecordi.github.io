// «Ruota» su una scansione storta: la pagina mostrata deve uscire DRITTA (30/10/2026: girava nel verso sbagliato).
// L'inclinazione si misura sullo screenshot della pagina, cioè su quello che si vede davvero.
const pw = require("playwright");
const chromium = pw[process.env.BROWSER || "chromium"];
const path = require("path");
const fs = require("fs");
const { BASE, SHOTS, check, watchErrors } = require("./common.cjs");

const ESEMPIO = process.env.ESEMPIO || path.join(__dirname, "..", "pdf", "esempi", "modulo-di-prova-scansionato.pdf");

// Gradi di cui le righe scendono verso destra (negativo: salgono), dalla concentrazione dei punti scuri.
async function pendenza(page, png) {
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
    const xs = [];
    const ys = [];
    for (let y = 0; y < height; y++) {
      for (let x = Math.round(width * 0.1); x < width * 0.9; x++) {
        const i = (y * width + x) * 4;
        if (data[i] + data[i + 1] + data[i + 2] < 300) { xs.push(x - width / 2); ys.push(y); }
      }
    }
    let migliore = 0;
    let best = -1;
    for (let a = -3; a <= 3.0001; a += 0.05) {
      const t = Math.tan((a * Math.PI) / 180);
      const righe = new Float64Array(height + 2 * width);
      for (let i = 0; i < xs.length; i++) righe[Math.round(ys[i] - xs[i] * t) + width]++;
      let s = 0;
      for (const v of righe) s += v * v;
      if (s > best) [best, migliore] = [s, a];
    }
    return Math.round(migliore * 100) / 100;
  }, "data:image/png;base64," + png.toString("base64"));
}

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors = [];
  watchErrors(page, errors);
  // finto compilatore: restituisce la scansione così com'è, come un modulo compilato
  const FAKE = "https://compilatore.prova";
  await page.route(FAKE + "/**", (route) => route.request().method() === "OPTIONS"
    ? route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } })
    : route.fulfill({ status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ pdf: fs.readFileSync(ESEMPIO).toString("base64"), metodo: "posizioni", compilati: [], mancanti: [] }) }));
  await page.goto(BASE + "#compilatore=" + encodeURIComponent(FAKE) + "&chiave=prova");
  await page.setInputFiles("#fileInput", ESEMPIO);
  await page.waitForSelector(".page[data-page-number='1'] canvas");
  await page.waitForTimeout(1500);
  const pag = await page.$(".page[data-page-number='1']");
  const prima = await pendenza(page, await pag.screenshot({ path: path.join(SHOTS, "raddrizza-prima.png") }));
  check("la scansione di prova è storta", Math.abs(prima) >= 0.3, `${prima}°`);
  await page.click("#btnRotate");
  await page.waitForFunction(() => /raddrizzat/.test(document.getElementById("toast").textContent), null, { timeout: 30000 });
  await page.waitForTimeout(600);
  // la pagina girata si fotografa dal contenitore, che non gira
  const box = await pag.boundingBox();
  const dopo = await pendenza(page, await page.screenshot({ path: path.join(SHOTS, "raddrizza-dopo.png"),
    clip: { x: box.x + 20, y: box.y + 20, width: box.width - 40, height: box.height - 40 } }));
  check("dopo «Ruota» la pagina è dritta", Math.abs(dopo) <= 0.15, `${prima}° → ${dopo}°`);

  // «Compila» apre il modulo compilato: deve restare raddrizzato (30/10/2026: tornava storto)
  await page.click("#btnFill");
  // Alessandro senza cassaforte aziendale: «Usa quelli della VM»
  await page.click(".cf-dialog button[value=salta]");
  await page.check("input[name=fillWho][value=azienda]");
  await page.click(".fill-dialog .btn.primary");
  await page.waitForSelector("#fillPanel:not([hidden])", { timeout: 15000 });
  await page.waitForFunction(() => /compilato/.test(document.getElementById("docTitle").textContent));
  await page.waitForSelector(".page[data-page-number='1'] canvas");
  await page.waitForTimeout(1500);
  const pag2 = await page.$(".page[data-page-number='1']");
  const box2 = await pag2.boundingBox();
  const compilato = await pendenza(page, await page.screenshot({ path: path.join(SHOTS, "raddrizza-compilato.png"),
    clip: { x: box2.x + 20, y: box2.y + 20, width: Math.min(box2.width, 700) - 40, height: Math.min(box2.height, 900) - 40 } }));
  check("il modulo compilato si apre già dritto", Math.abs(compilato) <= 0.15, `${compilato}°`);
  check("nessun errore nella pagina", errors.length === 0, errors.join(" | "));
  await b.close();
})();
