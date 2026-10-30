// Un collega dall'ufficio (link con «solo=collega»): prima i suoi dati, poi il modulo; profili Azienda e Personale.
const { chromium } = require("playwright");
const { FX, BASE, check, watchErrors } = require("./common.cjs");

const FAKE = "https://compilatore.prova";

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage();
  const errors = [];
  watchErrors(page, errors);
  let scheda = "";
  let salvata = null;
  let compilata = null;
  const json = (o) => ({ status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(o) });
  await page.route(FAKE + "/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST" } });
    if (req.url().endsWith("/miei-dati")) {
      if (req.method() === "GET") return route.fulfill(json({ nome: "Serena", testo: scheda }));
      salvata = JSON.parse(req.postData());
      scheda = salvata.testo;
      return route.fulfill(json({ ok: true }));
    }
    compilata = JSON.parse(req.postData());
    return route.fulfill(json({ pdf: require("fs").readFileSync(FX + "doc.pdf").toString("base64"), metodo: "campi", compilati: [], mancanti: [] }));
  });
  await page.goto(BASE + "#compilatore=" + encodeURIComponent(FAKE) + "&chiave=prova&solo=collega");
  await page.setInputFiles("#fileInput", FX + "doc.pdf");
  await page.waitForSelector(".page canvas");
  await page.click("#btnFill");
  await page.waitForSelector(".miei-dialog[open]", { timeout: 5000 });
  check("senza scheda: prima «I miei dati»", true);
  check("nome già proposto", (await page.inputValue(".miei-dialog input[data-voce='Nome e cognome']")) === "Serena");
  await page.fill(".miei-dialog input[data-voce='Nome e cognome']", "Serena Rossi");
  await page.fill(".miei-dialog input[data-voce='E-mail']", "serena@esempio.it");
  await page.fill(".miei-dialog textarea", "Patente B");
  await page.click(".miei-dialog .btn.primary");
  await page.waitForSelector(".fill-dialog[open]", { timeout: 5000 });
  check("scheda salvata", salvata && salvata.testo.includes("- **Nome e cognome**: Serena Rossi") && salvata.testo.includes("- Patente B"), salvata && salvata.testo);
  const visibili = await page.$$eval("input[name=fillWho]", (rr) => rr.filter((r) => !r.closest("label").hidden).map((r) => r.value));
  check("profili del collega: Azienda e Personale", visibili.join(",") === "personale,azienda", visibili.join(","));
  check("«I miei dati» nella finestra", await page.isVisible(".fill-dialog .fill-miei"));
  // riaprendo, i dati tornano nei campi
  await page.click(".fill-dialog .fill-miei");
  await page.waitForSelector(".miei-dialog[open]");
  check("riaperta: i dati salvati", (await page.inputValue(".miei-dialog input[data-voce='E-mail']")) === "serena@esempio.it"
    && (await page.inputValue(".miei-dialog textarea")) === "Patente B");
  await page.click(".miei-dialog button[value=cancel]");
  await page.check("input[name=fillWho][value=azienda]");
  await page.click(".fill-dialog .btn.primary");
  await page.waitForSelector("#fillPanel:not([hidden])", { timeout: 10000 });
  check("compila col profilo azienda", compilata && compilata.profilo === "azienda");
  check("nessun errore nella pagina", errors.length === 0, errors.join(" | "));
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
