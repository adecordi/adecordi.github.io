// Un collega dall'ufficio (link con «solo=collega») con la cassaforte aziendale: entra con le sue credenziali, al
// primo Compila scrive i suoi dati nella SUA raccolta, e le schede arrivano al compilatore.
// La cassaforte è un Vaultwarden DI PROVA (VW=http://127.0.0.1:8299, tunnel verso il server di prova): senza, salta.
const { chromium } = require("playwright");
const { FX, BASE, check, watchErrors } = require("./common.cjs");

const FAKE = "https://compilatore.prova";
const VW = process.env.VW;

(async () => {
  if (!VW) {
    console.log("VW non impostato: prova della cassaforte saltata (serve un Vaultwarden di prova).");
    return;
  }
  const { creaUtente, http, chiudi } = await import("./vw_prova.mjs");
  const u = await creaUtente(VW, "Serena Prova");
  // i dati della Vinicola li mette il proprietario nella raccolta «Tutti» (qui lo stesso utente di prova)
  const azienda = await chiudi(new TextEncoder().encode("Ragione sociale: Vinicola di prova S.p.A."), u.chiaveOrg);
  await http(VW, "/api/ciphers/create", "POST", { cipher: { type: 2, organizationId: u.org, secureNote: { type: 0 },
    name: await chiudi(new TextEncoder().encode("Dati della Vinicola per i moduli (C.A.R.T.A.)"), u.chiaveOrg), notes: azienda },
  collectionIds: [u.tutti] }, u.token);

  const b = await chromium.launch();
  const page = await b.newPage();
  const errors = [];
  watchErrors(page, errors);
  let compilata = null;
  const json = (o) => ({ status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(o) });
  await page.route(FAKE + "/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST" } });
    compilata = JSON.parse(req.postData());
    return route.fulfill(json({ pdf: require("fs").readFileSync(FX + "doc.pdf").toString("base64"), metodo: "campi", compilati: [], mancanti: [] }));
  });
  // la cassaforte «vera» per la pagina è quella di prova
  await page.route("https://cassaforte.it.fo/**", async (route) => {
    const req = route.request();
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, PUT" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const res = await route.fetch({ url: req.url().replace("https://cassaforte.it.fo", VW) });
    return route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
  });
  await page.goto(BASE + "#compilatore=" + encodeURIComponent(FAKE) + "&chiave=prova&solo=collega");
  await page.setInputFiles("#fileInput", FX + "doc.pdf");
  await page.waitForSelector(".page canvas");
  await page.click("#btnFill");
  await page.waitForSelector(".cf-dialog[open]", { timeout: 5000 });
  check("al primo Compila: accesso alla cassaforte", true);
  check("il collega non può saltarla", await page.isHidden(".cf-dialog .cf-salta"));
  await page.fill(".cf-dialog input[name=email]", u.email);
  await page.fill(".cf-dialog input[name=password]", "sbagliata");
  await page.click(".cf-dialog .btn.primary");
  await page.waitForFunction(() => /sbagliat/.test(document.querySelector(".cf-errore").textContent), null, { timeout: 20000 });
  check("password sbagliata: lo dice", true);
  await page.fill(".cf-dialog input[name=password]", u.password);
  await page.click(".cf-dialog .btn.primary");
  await page.waitForSelector(".miei-dialog[open]", { timeout: 30000 });
  check("senza i suoi dati: «I miei dati»", true);
  check("nome dalla cassaforte", (await page.inputValue(".miei-dialog input[data-voce='Nome e cognome']")) === "Serena Prova");
  await page.fill(".miei-dialog input[data-voce='E-mail']", "serena@esempio.it");
  await page.fill(".miei-dialog textarea", "Patente B");
  await page.click(".miei-dialog .btn.primary");
  await page.waitForSelector(".fill-dialog[open]", { timeout: 30000 });
  const visibili = await page.$$eval("input[name=fillWho]", (rr) => rr.filter((r) => !r.closest("label").hidden).map((r) => r.value));
  check("profili del collega: Azienda e Personale", visibili.join(",") === "personale,azienda", visibili.join(","));
  await page.check("input[name=fillWho][value=azienda]");
  await page.click(".fill-dialog .btn.primary");
  await page.waitForSelector("#fillPanel:not([hidden])", { timeout: 15000 });
  const sc = compilata && compilata.schede;
  check("al compilatore i suoi dati, dalla cassaforte", sc && sc.persona.includes("- **E-mail**: serena@esempio.it") && sc.persona.includes("- Patente B"), sc && sc.persona);
  check("e quelli della Vinicola", sc && sc.azienda === "Ragione sociale: Vinicola di prova S.p.A.");
  // riaprendo «I miei dati» (già dentro: niente password) li ritrova nella cassaforte
  await page.click("#btnFill");
  await page.waitForSelector(".fill-dialog[open]", { timeout: 15000 });
  await page.click(".fill-dialog .fill-miei");
  await page.waitForSelector(".miei-dialog[open]", { timeout: 15000 });
  check("riaperta: i dati salvati nella cassaforte", (await page.inputValue(".miei-dialog input[data-voce='E-mail']")) === "serena@esempio.it");
  check("nessun errore nella pagina", errors.filter((e) => !/401|400/.test(e)).length === 0, errors.join(" | "));

  // --- Alessandro (chiave sua, proprietario): la prima volta copia dalla VM i dati della Vinicola e i suoi
  const a = await creaUtente(VW, "Alessandro Prova");
  const p2 = await b.newPage();
  let compilata2 = null;
  await p2.route(FAKE + "/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST" } });
    if (req.url().endsWith("/esporta-schede")) return route.fulfill(json({ persona: "## Dati di Alessandro\n- Codice fiscale: XXXPRV00A01X000X", azienda: "Ragione sociale: Vinicola dalla VM S.p.A." }));
    compilata2 = JSON.parse(req.postData());
    return route.fulfill(json({ pdf: require("fs").readFileSync(FX + "doc.pdf").toString("base64"), metodo: "campi", compilati: [], mancanti: [] }));
  });
  await p2.route("https://cassaforte.it.fo/**", async (route) => {
    const req = route.request();
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, PUT" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const res = await route.fetch({ url: req.url().replace("https://cassaforte.it.fo", VW) });
    return route.fulfill({ response: res, headers: { ...res.headers(), ...cors } });
  });
  const domande = [];
  p2.on("dialog", (d) => {
    domande.push(d.message());
    return d.type() === "prompt" ? d.accept("2") : d.accept(); // 2 = «Tutti» (1 è la sua)
  });
  await p2.goto(BASE + "#compilatore=" + encodeURIComponent(FAKE) + "&chiave=prova");
  await p2.setInputFiles("#fileInput", FX + "doc.pdf");
  await p2.waitForSelector(".page canvas");
  await p2.click("#btnFill");
  await p2.waitForSelector(".cf-dialog[open]", { timeout: 5000 });
  check("Alessandro può ancora usare la VM", await p2.isVisible(".cf-dialog .cf-salta"));
  await p2.fill(".cf-dialog input[name=email]", a.email);
  await p2.fill(".cf-dialog input[name=password]", a.password);
  await p2.click(".cf-dialog .btn.primary");
  await p2.waitForSelector(".miei-dialog[open]", { timeout: 40000 });
  check("propone di copiare i dati della Vinicola dalla VM", domande.some((m) => /dati della Vinicola/.test(m)), domande.join(" / "));
  check("«I miei dati» già con quelli della VM", (await p2.inputValue(".miei-dialog textarea")).includes("XXXPRV00A01X000X"));
  await p2.click(".miei-dialog .btn.primary");
  await p2.waitForSelector(".fill-dialog[open]", { timeout: 30000 });
  await p2.check("input[name=fillWho][value=azienda_io]");
  await p2.click(".fill-dialog .btn.primary");
  await p2.waitForSelector("#fillPanel:not([hidden])", { timeout: 15000 });
  const sc2 = compilata2 && compilata2.schede;
  check("al compilatore le schede copiate nella cassaforte", sc2 && sc2.azienda === "Ragione sociale: Vinicola dalla VM S.p.A."
    && sc2.persona.includes("XXXPRV00A01X000X"), JSON.stringify(sc2));
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
