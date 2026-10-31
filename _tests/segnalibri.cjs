// «Segnalibri» (31/10/2026): l'indice del PDF nel pannello accanto, con il salto alle voci; i segnalibri propri
// che restano nel browser e si ritrovano riaprendo lo stesso file; «non ha un indice» per un PDF senza outline.
const { chromium } = require("playwright");
const { SHOTS, BASE, check, watchErrors, openFixture, text } = require("./common.cjs");

const PAGINA1 = ".page[data-page-number='1'] .textLayer span";
const vociIndice = (page) => page.$$eval(".seg-indice .seg-voce", (b) => b.map((x) => x.textContent.trim()));
const vociMiei = (page) => page.$$eval(".seg-miei .seg-voce span", (b) => b.map((x) => x.textContent.trim()));
const paginaE = (page, n) => page.waitForFunction((n) => document.getElementById("pageNumber").value === String(n), n, { timeout: 5000 });
const apri = async (page, nome) => {
  await openFixture(page, nome);
  await page.waitForSelector(PAGINA1);
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  watchErrors(page, errors);
  await page.goto(BASE);
  check("senza documento il pulsante non c'è", await page.isHidden("#btnSegnalibri"));

  // l'indice del documento
  await apri(page, "indice.pdf");
  check("con il PDF il pulsante compare", await page.isVisible("#btnSegnalibri"));
  await page.click("#btnSegnalibri");
  await page.waitForSelector("#segPanel:not([hidden]) .seg-indice");
  const voci = await vociIndice(page);
  check("l'indice mostra le voci dei due livelli", voci.length === 7 && voci.includes("Capitolo 2 - Condizioni") && voci.includes("2.2 Consegna"), voci.join(" | "));
  // i capitoli 1 e 2 hanno sottovoci, il 3 no
  check("i capitoli con sottovoci sono rami <details> aperti", (await page.$$eval(".seg-indice details[open]", (d) => d.length)) === 2);
  check("il PDF resta accanto al pannello", await page.evaluate(() => document.body.classList.contains("panel-open"))
    && (await page.getAttribute("#btnSegnalibri", "aria-expanded")) === "true");
  await page.click(".seg-indice .seg-voce:has-text('2.2 Consegna')");
  await paginaE(page, 3);
  check("clic su una voce di secondo livello: pagina 3", (await page.inputValue("#pageNumber")) === "3");
  await page.click(".seg-indice .seg-voce:has-text('Capitolo 1')");
  await paginaE(page, 1);
  check("clic su un capitolo: pagina 1", (await page.inputValue("#pageNumber")) === "1");
  await page.screenshot({ path: SHOTS + "segnalibri-indice.png" });

  // i miei segnalibri: aggiungo la pagina 2
  check("all'inizio nessun segnalibro", await page.isVisible(".seg-miei .seg-vuoto"));
  await page.fill("#pageNumber", "2");
  await page.press("#pageNumber", "Enter");
  await paginaE(page, 2);
  check("il titolo proposto segue la pagina", (await page.getAttribute("#segTitolo", "placeholder")) === "Pagina 2", await page.getAttribute("#segTitolo", "placeholder"));
  await page.click("#segAggiungi");
  await page.waitForSelector(".seg-miei .seg-voce");
  check("«Aggiungi la pagina corrente»: voce «Pagina 2»", (await vociMiei(page)).join() === "Pagina 2", (await vociMiei(page)).join());
  check("con la pagina accanto", /pag\. 2/.test(await text(page, ".seg-miei")));
  await page.click("#segAggiungi");
  check("la stessa pagina non si aggiunge due volte", (await vociMiei(page)).length === 1 && /già un segnalibro/.test(await text(page, "#toast")));
  await page.fill("#segTitolo", "Clausola importante");
  await page.press("#segTitolo", "Enter");
  await page.waitForFunction(() => document.querySelectorAll(".seg-miei .seg-voce").length === 2);
  check("con un nome scelto: seconda voce", (await vociMiei(page)).join("|") === "Pagina 2|Clausola importante", (await vociMiei(page)).join("|"));
  await page.screenshot({ path: SHOTS + "segnalibri-miei.png" });

  // ricarico la pagina e riapro lo stesso file: i segnalibri ci sono ancora
  await page.reload();
  await page.waitForSelector("#btnOpenBig");
  await apri(page, "indice.pdf");
  check("riaperto, il pannello parte chiuso", await page.isHidden("#segPanel"));
  await page.click("#btnSegnalibri");
  await page.waitForSelector(".seg-miei .seg-voce");
  check("dopo la ricarica i segnalibri ci sono ancora", (await vociMiei(page)).join("|") === "Pagina 2|Clausola importante", (await vociMiei(page)).join("|"));
  await page.click(".seg-miei .seg-voce:has-text('Clausola importante')");
  await paginaE(page, 2);
  check("clic sul segnalibro: pagina 2", (await page.inputValue("#pageNumber")) === "2");

  // elimino
  await page.click(".seg-miei li:has-text('Clausola importante') .seg-elimina");
  await page.waitForFunction(() => document.querySelectorAll(".seg-miei .seg-voce").length === 1);
  await page.click(".seg-miei .seg-elimina");
  await page.waitForSelector(".seg-miei .seg-vuoto");
  check("eliminati: l'elenco è vuoto", (await vociMiei(page)).length === 0);
  await page.reload();
  await page.waitForSelector("#btnOpenBig");
  await apri(page, "indice.pdf");
  await page.click("#btnSegnalibri");
  await page.waitForSelector(".seg-miei .seg-vuoto");
  check("e resta vuoto anche dopo la ricarica", (await vociMiei(page)).length === 0);

  // Escape chiude il pannello; un altro documento lo trova chiuso
  await page.keyboard.press("Escape");
  check("Escape chiude il pannello", await page.isHidden("#segPanel") && (await page.getAttribute("#btnSegnalibri", "aria-expanded")) === "false");
  await page.click("#btnSegnalibri");
  await page.waitForSelector("#segPanel:not([hidden])");
  await apri(page, "doc.pdf");
  check("cambiando documento il pannello si chiude", await page.isHidden("#segPanel"));
  await page.click("#btnSegnalibri");
  await page.waitForSelector("#segPanel:not([hidden]) .seg-niente");
  check("doc.pdf: «non ha un indice»", /Questo documento non ha un indice/.test(await text(page, "#segBody")), await text(page, "#segBody"));
  check("doc.pdf: i segnalibri di indice.pdf non ci sono", await page.isVisible(".seg-miei .seg-vuoto"));

  // un solo pannello alla volta: aprendo le firme i segnalibri si chiudono, e viceversa
  await apri(page, "doc.pdf.p7m");
  await page.click("#btnSegnalibri");
  await page.waitForSelector("#segPanel:not([hidden])");
  await page.click("#sigChip");
  await page.waitForSelector("#sigPanel:not([hidden])");
  await page.waitForTimeout(100);
  check("le firme chiudono i segnalibri", await page.isHidden("#segPanel") && (await page.getAttribute("#btnSegnalibri", "aria-expanded")) === "false");
  await page.click("#btnSegnalibri");
  await page.waitForSelector("#segPanel:not([hidden])");
  await page.waitForTimeout(100);
  check("i segnalibri chiudono le firme", await page.isHidden("#sigPanel") && (await page.getAttribute("#sigChip", "aria-expanded")) === "false");
  await page.click("#segClose");
  check("la «x» chiude il pannello", await page.isHidden("#segPanel"));

  // salvando con le annotazioni i byte cambiano: copiaPer porta i segnalibri sotto l'impronta nuova, uniti a quelli già là
  const copiati = await page.evaluate(async () => {
    const m = await import("./segnalibri.js");
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5, 6]);
    const hex = async (x) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", x)), (v) => v.toString(16).padStart(2, "0")).join("");
    const db = await new Promise((ok, no) => {
      const r = indexedDB.open("carta-segnalibri", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("segnalibri");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    });
    const op = (modo, k, v) => new Promise((ok, no) => {
      const t = db.transaction("segnalibri", "readwrite").objectStore("segnalibri");
      const r = modo === "get" ? t.get(k) : t.put(v, k);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    });
    await op("put", await hex(a), [{ pagina: 1, titolo: "Uno", quando: 1 }]);
    await op("put", await hex(b), [{ pagina: 2, titolo: "Due", quando: 2 }]);
    await m.copiaPer(a, b);
    return (await op("get", await hex(b))).map((s) => s.titolo).join("|");
  });
  check("salvato con annotazioni: i segnalibri seguono i byte nuovi", copiati === "Uno|Due", copiati);

  check("nessun errore nella pagina", !errors.length, errors.join(" | "));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
