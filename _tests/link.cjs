// Link nei PDF: nessun riquadro giallo al passaggio del mouse, link funzionante.
const { chromium } = require("playwright");
const { FX, SHOTS, BASE, check } = require("./common.cjs");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.goto(BASE);
  await page.setInputFiles("#fileInput", FX + "link_chrome.pdf");
  const link = await page.waitForSelector(".annotationLayer .linkAnnotation a");
  await page.waitForTimeout(500);
  await link.hover();
  const style = await link.evaluate((a) => { const cs = getComputedStyle(a); return { bg: cs.backgroundColor, shadow: cs.boxShadow, opacity: cs.opacity, cursor: cs.cursor }; });
  check("niente evidenziazione al passaggio", style.bg === "rgba(0, 0, 0, 0)" && style.shadow === "none" && style.opacity === "1", JSON.stringify(style));
  check("manina sul link", style.cursor === "pointer");
  check("si apre in una nuova scheda", (await link.getAttribute("target")) === "_blank" && (await link.getAttribute("href")).endsWith("scheda.pdf"));
  const box = await link.boundingBox();
  await page.screenshot({ path: SHOTS + "30-link.png", clip: { x: Math.max(0, box.x - 120), y: box.y - 80, width: 760, height: 220 } });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
