// «Ruota» su una scansione storta: la pagina mostrata deve uscire DRITTA (30/10/2026: girava nel verso sbagliato).
// L'inclinazione si misura sullo screenshot della pagina, cioè su quello che si vede davvero.
const { chromium } = require("playwright");
const path = require("path");
const { BASE, SHOTS, check, watchErrors } = require("./common.cjs");

const ESEMPIO = path.join(__dirname, "..", "pdf", "esempi", "modulo-di-prova-scansionato.pdf");

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
  await page.goto(BASE);
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
  check("nessun errore nella pagina", errors.length === 0, errors.join(" | "));
  await b.close();
})();
