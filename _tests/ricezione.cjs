// File ricevuti da altre app: "Condividi" su Android (share target del service worker) e trascinamento.
const { chromium } = require("playwright");
const fs = require("fs");
const { FX, BASE, check, watchErrors, text } = require("./common.cjs");

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const errors = [];
  watchErrors(page, errors);
  await page.goto(BASE);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const b64 = fs.readFileSync(FX + "doc_ec.pdf.p7m").toString("base64");
  const target = await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const form = new FormData();
    form.append("file", new File([bytes], "condiviso.pdf.p7m", { type: "application/pkcs7-mime" }));
    return (await fetch("./?share-target", { method: "POST", body: form })).url;
  }, b64);
  await page.goto(target);
  await page.waitForSelector(".page canvas");
  check("file condiviso da un'altra app", (await text(page, "#docTitle")) === "condiviso.pdf" && page.url() === BASE);

  await page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "trascinato.pdf.p7m"));
    for (const type of ["dragenter", "dragover", "drop"]) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, b64);
  await page.waitForFunction(() => document.getElementById("docTitle").textContent === "trascinato.pdf");
  check("file trascinato nella finestra", true);
  check("nessun errore nella pagina", !errors.length, errors.join(" | "));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
