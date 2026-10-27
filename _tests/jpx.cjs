// Immagini JPEG 2000 decodificate con il WebAssembly di PDF.js.
const fs = require("fs");
const { chromium } = require("playwright");
const { FX, BASE, check } = require("./common.cjs");

(async () => {
  if (!fs.existsSync(FX + "jpx.pdf")) {
    console.log("– jpx.pdf assente (serve ImageMagick con JPEG 2000): test saltato");
    return;
  }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const wasm = [];
  page.on("request", (r) => r.url().endsWith(".wasm") && wasm.push(r.url().split("/").pop()));
  await page.goto(BASE);
  await page.setInputFiles("#fileInput", FX + "jpx.pdf");
  await page.waitForSelector(".page canvas");
  await page.waitForTimeout(1500);
  const pixel = await page.$eval(".page canvas", (c) => Array.from(c.getContext("2d").getImageData(c.width / 4, c.height / 4, 1, 1).data));
  check("immagine JPEG 2000 visibile", Math.abs(pixel[0] - 135) < 6 && Math.abs(pixel[2] - 235) < 6, pixel.join(","));
  check("decodificatore openjpeg.wasm caricato", wasm.includes("openjpeg.wasm"));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
