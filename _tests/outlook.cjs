// Modalità Outlook con office.js simulato: allegati, PEC con postacert.eml,
// cambio messaggio, apertura in una finestra grande.
const { chromium } = require("playwright");
const fs = require("fs");
const { FX, SHOTS, BASE, check, watchErrors, text } = require("./common.cjs");

const b64 = (f) => fs.readFileSync(FX + f).toString("base64");
const wrap = (s) => s.match(/.{1,76}/g).join("\r\n");
const eml = [
  "From: posta-certificata@pec.example.it", "Subject: POSTA CERTIFICATA: Documenti", "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b1"', "", "--b1",
  "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "", "Testo del messaggio =C3=A0", "--b1",
  'Content-Type: application/pkcs7-mime; name="contratto.pdf.p7m"', "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment;\r\n filename="contratto.pdf.p7m"', "", wrap(b64("doc.pdf.p7m")), "--b1",
  "Content-Type: application/pkcs7-mime", "Content-Transfer-Encoding: base64",
  "Content-Disposition: attachment; filename*=UTF-8''fattura%20n%C2%B042.xml.p7m", "", wrap(b64("IT01234567890_00042.xml.p7m")), "--b1--", "",
].join("\r\n");

const mailbox = {
  m1: { itemId: "m1", attachments: [
    { id: "a1", name: "doc.pdf.p7m", size: 6635, attachmentType: "file", isInline: false },
    { id: "a2", name: "logo.png", size: 900, attachmentType: "file", isInline: true },
  ] },
  m2: { itemId: "m2", attachments: [
    { id: "p1", name: "daticert.xml", size: 1500, attachmentType: "file", isInline: false },
    { id: "p2", name: "postacert.eml", size: 30000, attachmentType: "item", isInline: false },
  ] },
};
const contents = {
  a1: { format: "base64", content: b64("doc.pdf.p7m") },
  p1: { format: "base64", content: Buffer.from("<daticert><tipo>accettazione</tipo></daticert>").toString("base64") },
  p2: { format: "eml", content: eml },
};
const officeMock = `
  window.__mailbox = ${JSON.stringify(mailbox)}; window.__contents = ${JSON.stringify(contents)};
  const mk = (it) => it && Object.assign({}, it, { getAttachmentContentAsync(id, cb) { setTimeout(() => { const c = window.__contents[id];
    cb(c ? { status: "succeeded", value: c } : { status: "failed", error: { message: "non trovato" } }); }, 30); } });
  window.Office = {
    HostType: { Outlook: "Outlook" }, AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" },
    EventType: { ItemChanged: "olkItemSelectedChanged" },
    MailboxEnums: { AttachmentContentFormat: { Base64: "base64", Url: "url", Eml: "eml", ICalendar: "iCalendar" } },
    onReady: () => Promise.resolve({ host: "Outlook", platform: "OfficeOnline" }),
    context: { requirements: { isSetSupported: () => true },
      mailbox: { item: mk(window.__mailbox.m1), addHandlerAsync(t, h) { window.__changed = h; } } },
  };
  window.__select = (id) => { Office.context.mailbox.item = mk(window.__mailbox[id]); window.__changed(); };`;

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 380, height: 760 } });
  await ctx.route("https://appsforoffice.microsoft.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: officeMock }));
  const p = await ctx.newPage();
  const errors = [];
  watchErrors(p, errors);
  await p.goto(BASE + "?outlook=1");
  await p.waitForSelector(".page canvas", { timeout: 15000 });
  check("unico allegato aperto da solo", (await text(p, "#docTitle")) === "doc.pdf" && (await text(p, "#sigChip")) === "Firmato da Mario Rossi");
  check("niente service worker in Outlook", (await p.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length))) === 0);
  await p.click("#btnOpen");
  await p.waitForSelector(".att-item");
  check("pulsante Allegati torna all'elenco", (await p.$$eval(".att-item strong", (a) => a.map((x) => x.textContent))).join() === "doc.pdf.p7m");
  check("nessun testo spurio nell'elenco", !(await text(p, "#dropCard")).includes("null"));

  await p.evaluate(() => window.__select("m2"));
  await p.waitForSelector(".att-list.nested .att-item", { timeout: 10000 });
  const names = await p.$$eval(".att-item strong", (a) => a.map((x) => x.textContent));
  check("PEC: allegati dentro postacert.eml", names.join(" | ") === "daticert.xml | postacert.eml | contratto.pdf.p7m | fattura n°42.xml.p7m", names.join(" | "));
  await p.screenshot({ path: SHOTS + "20-outlook-pec.png" });
  await p.click(".att-list.nested .att-item:has-text('fattura')");
  await p.waitForSelector(".invoice", { timeout: 10000 });
  check("fattura della PEC aperta", (await text(p, "#docTitle")) === "fattura n°42.xml");

  const [popup] = await Promise.all([p.waitForEvent("popup"), p.click("#btnWindow")]);
  await popup.waitForSelector(".invoice", { timeout: 15000 });
  check("finestra grande riceve il documento", (await text(popup, "#docTitle")) === "fattura n°42.xml");
  await p.click("#btnOpen");
  await p.waitForSelector(".att-item");
  await p.click(".att-item:has-text('daticert.xml')");
  await p.waitForSelector("#altView pre");
  check("ricevuta PEC leggibile", (await p.textContent("#altView pre")).includes("accettazione"));
  check("nessun errore nella pagina", !errors.length, errors.join(" | "));

  // Fuori da Outlook (office.js non disponibile) il lettore resta normale.
  const plain = await browser.newContext();
  await plain.route("https://appsforoffice.microsoft.com/**", (r) => r.abort());
  const q = await plain.newPage();
  await q.goto(BASE + "?outlook=1");
  await q.waitForTimeout(1500);
  check("fuori da Outlook: modalità normale", !(await q.evaluate(() => document.body.classList.contains("outlook"))) && await q.isHidden("#btnWindow"));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
