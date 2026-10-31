// La prova «su più dispositivi» (31/10/2026): le stesse nove verifiche su desktop, finestra «come app», Android,
// iPhone, iPad e Firefox. Sono emulazioni di Playwright (Chromium, WebKit, Firefox) e NON telefoni veri: dicono se il
// motore del browser regge, non come si comporta Safari vero (menu di sistema, selezione col dito, memoria).
// Non sta in run.cjs perché è lenta: si lancia a parte. Uso: node dispositivi.cjs [versione]
// Scrive shots/dispositivi_<versione>.json e uno screenshot per dispositivo (shots/dispositivo-<nome>.png).
const { chromium, webkit, firefox, devices } = require("playwright");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// Server proprio, su una porta che run.cjs non usa. BASE_URL va fissato PRIMA di caricare common.cjs.
const PORTA = 8771;
process.env.BASE_URL = `http://127.0.0.1:${PORTA}/pdf/`;
const { FX, SHOTS, BASE, check, watchErrors, openFixture } = require("./common.cjs");

const RADICE = path.join(__dirname, "..");
const ESEMPIO = path.join(RADICE, "pdf", "esempi", "conto-corrente-dedicato.pdf");
const PROVE = ["apri", "zoom", "selezione", "firma", "ocr", "salva", "offline", "manifest", "condividi"];
// Se il documento non si apre, queste non hanno nulla su cui lavorare.
const DIPENDONO_DA_APRI = ["zoom", "selezione", "firma", "salva"];

const versione = process.argv[2] || (/const VERSION = "([^"]+)"/.exec(fs.readFileSync(path.join(RADICE, "pdf", "sw.js"), "utf8")) || [])[1] || "sconosciuta";
const oggi = (() => { const n = new Date(); const z = (x) => String(x).padStart(2, "0"); return `${n.getFullYear()}-${z(n.getMonth() + 1)}-${z(n.getDate())}`; })();

const DESKTOP = { viewport: { width: 1280, height: 900 } };
const DISPOSITIVI = [
  { id: "desktop", nome: "Desktop 1280x900", browser: "chromium", ctx: DESKTOP },
  // In headless --app non apre una vera finestra «come app»: la pagina di prova gira in un context 1100x760 (vedi note).
  { id: "app", nome: "Desktop come app", browser: "chromium", args: ["--app=" + BASE], ctx: { viewport: { width: 1100, height: 760 } } },
  { id: "android", nome: "Android (Pixel 7)", browser: "chromium", ctx: devices["Pixel 7"] },
  { id: "iphone", nome: "iPhone 13", browser: "webkit", ctx: devices["iPhone 13"] },
  { id: "ipad", nome: "iPad Pro 11", browser: "webkit", ctx: devices["iPad Pro 11"] },
  { id: "firefox", nome: "Firefox desktop", browser: "firefox", ctx: DESKTOP },
];
const MOTORI = { chromium, webkit, firefox };

class NonProvato extends Error {}
const nonProvato = (motivo) => { throw new NonProvato(motivo); };
const breve = (e) => String((e && e.message) || e).split("\n")[0].replace(/\s+/g, " ").slice(0, 220);
const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

// Apre un file e aspetta che la pagina sia disegnata (come openFixture, ma per un percorso qualsiasi).
async function apriFile(page, file) {
  await page.setInputFiles("#fileInput", file);
  await page.waitForFunction(() => document.getElementById("busy").hidden
    && !document.getElementById("sigChip").classList.contains("pending"), null, { timeout: 30000 });
  await page.waitForSelector(".page[data-page-number='1'] canvas", { state: "visible", timeout: 20000 });
}

// Server dei test su una porta propria. Si ferma DAVVERO per la prova offline: setOffline di Playwright su WebKit
// blocca anche le richieste che il service worker servirebbe dalla cache («internal error» al ricaricamento).
function creaServer() {
  let proc = null;
  const su = () => new Promise((resolve) => http.get(BASE, (res) => { res.resume(); resolve(res.statusCode === 200); }).on("error", () => resolve(false)));
  return {
    async avvia() {
      if (await su()) throw new Error(`la porta ${PORTA} è già occupata da un altro server`);
      const figlio = spawn(process.execPath, [path.join(__dirname, "server.cjs"), RADICE, String(PORTA)], { stdio: "ignore" });
      proc = figlio;
      for (let i = 0; i < 60 && !(await su()); i++) {
        if (figlio.exitCode !== null) throw new Error("il server dei test non parte");
        await attesa(100);
      }
    },
    async ferma() {
      if (!proc) return;
      const figlio = proc;
      proc = null;
      const uscito = new Promise((resolve) => figlio.once("exit", resolve));
      figlio.kill();
      if (figlio.exitCode === null) await uscito;
      for (let i = 0; i < 50 && (await su()); i++) await attesa(100);
    },
    chiudi() { if (proc) proc.kill(); },
  };
}

// Gli errori di sintassi non fermano la prova (altrimenti non resta nessun rapporto): si segnalano e basta.
function controllaSintassi() {
  const sito = path.join(RADICE, "pdf");
  const guasti = [];
  for (const f of fs.readdirSync(sito).filter((x) => x.endsWith(".js") && x !== "sw.js")) {
    const copia = path.join(os.tmpdir(), "carta-check-" + f.replace(/\.js$/, ".mjs"));
    fs.copyFileSync(path.join(sito, f), copia);
    const r = spawnSync(process.execPath, ["--check", copia], { encoding: "utf8" });
    if (r.status !== 0) guasti.push(`${f}: ${(r.stderr || "").split("\n").find((l) => /Error/.test(l)) || "errore di sintassi"}`);
  }
  return guasti;
}

// Un browser che manca si scarica (npx playwright install); se non si riesce, il dispositivo è «non provato».
async function lanciaBrowser(d) {
  const motore = MOTORI[d.browser];
  if (!fs.existsSync(motore.executablePath())) {
    console.log(`  scarico ${d.browser} (npx playwright install ${d.browser})…`);
    spawnSync("npx", ["playwright", "install", d.browser], { cwd: __dirname, shell: true, stdio: "inherit" });
  }
  return motore.launch(d.args ? { args: d.args } : {});
}

async function provaDispositivo(d, server) {
  console.log(`\n▶ ${d.nome} (${d.browser})`);
  const esiti = {};
  const note = [];
  const errori = [];
  const tocco = !!d.ctx.hasTouch;
  const tocca = (page, sel) => (tocco ? page.tap(sel) : page.click(sel));
  const clip = d.browser === "chromium" ? { permissions: ["clipboard-read", "clipboard-write"] } : {};
  const opzioni = { ...d.ctx, acceptDownloads: true, ...clip };

  // Una prova: ok se non solleva, «non provato» se lo dice lei, «no» in ogni altro caso.
  const prova = async (nome, fn) => {
    try {
      const nota = await fn();
      esiti[nome] = "ok";
      check(`${d.nome}: ${nome}`, true, nota || "");
      if (nota) note.push(`${nome}: ${nota}`);
    } catch (e) {
      const msg = breve(e);
      if (e instanceof NonProvato) {
        esiti[nome] = "non provato";
        console.log(`– ${d.nome}: ${nome} non provato — ${msg}`);
      } else {
        esiti[nome] = "no";
        check(`${d.nome}: ${nome}`, false, msg);
      }
      note.push(`${nome}: ${msg}`);
    }
  };
  const fine = () => ({ dispositivo: d.nome, browser: d.browser, modo: "emulato", esiti: Object.fromEntries(PROVE.map((p) => [p, esiti[p] || "non provato"])), note: note.join(" | ") });

  let browser;
  try {
    browser = await lanciaBrowser(d);
  } catch (e) {
    const motivo = `${d.browser} non si avvia: ${breve(e)}`;
    for (const p of PROVE) esiti[p] = "non provato";
    note.push(motivo);
    console.log(`– ${d.nome}: non provato — ${motivo}`);
    return fine();
  }

  try {
    const ctx = await browser.newContext({ ...opzioni, serviceWorkers: "block" });
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);
    watchErrors(page, errori);
    page.on("dialog", (dlg) => dlg.accept().catch(() => {}));

    await page.goto(BASE, { waitUntil: "load" }).catch((e) => note.push("caricamento: " + breve(e)));
    if (d.id === "app") {
      const standalone = await page.evaluate(() => matchMedia("(display-mode: standalone)").matches).catch(() => false);
      note.push(standalone ? "finestra --app riconosciuta (display-mode: standalone)"
        : "--app non cambia nulla in headless (display-mode: browser): provata la geometria 1100x760 in un context normale");
    }

    // 1. apre l'esempio e vede il canvas con qualcosa disegnato
    await prova("apri", async () => {
      await apriFile(page, ESEMPIO);
      const h = await page.waitForFunction(() => {
        const c = document.querySelector(".page[data-page-number='1'] canvas");
        if (!c || !c.width || !c.height) return false;
        const t = document.createElement("canvas");
        t.width = t.height = 48;
        const x = t.getContext("2d");
        x.drawImage(c, 0, 0, 48, 48);
        const px = x.getImageData(0, 0, 48, 48).data;
        let scuri = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0 && (px[i] < 245 || px[i + 1] < 245 || px[i + 2] < 245)) scuri++;
        return scuri > 0 ? { w: c.width, h: c.height, scuri } : false;
      }, null, { timeout: 15000 }).catch(() => null);
      if (!h) throw new Error("il canvas c'è ma resta bianco");
      const v = await h.jsonValue();
      return `canvas ${v.w}x${v.h}`;
    });
    if (esiti.apri !== "ok") for (const p of DIPENDONO_DA_APRI) { esiti[p] = "non provato"; note.push(`${p}: serve il documento aperto`); console.log(`– ${d.nome}: ${p} non provato — documento non aperto`); }

    // 2. zoom +
    if (esiti.zoom === undefined) await prova("zoom", async () => {
      if (!(await page.isVisible("#btnZoomIn"))) throw new Error("il pulsante Ingrandisci non si vede");
      const larg = () => page.evaluate(() => document.querySelector(".page[data-page-number='1']").getBoundingClientRect().width);
      const prima = await larg();
      await tocca(page, "#btnZoomIn");
      await page.waitForFunction((w) => document.querySelector(".page[data-page-number='1']").getBoundingClientRect().width > w + 1, prima, { timeout: 6000 })
        .catch(() => { throw new Error(`la pagina non si ingrandisce (${Math.round(prima)} px)`); });
      return `pagina ${Math.round(prima)} → ${Math.round(await larg())} px`;
    });

    // 3. selezione del testo: strato di testo presente e una selezione restituisce testo
    if (esiti.selezione === undefined) await prova("selezione", async () => {
      const righe = ".page[data-page-number='1'] .textLayer span";
      await page.waitForSelector(righe, { state: "attached", timeout: 15000 }).catch(() => { throw new Error("manca lo strato di testo (textLayer)"); });
      // dopo lo zoom lo strato di testo viene ricostruito: si aspetta che ci siano parole vere (a Firefox serve qualche istante)
      const trovati = await page.waitForFunction((sel) => {
        const c = [...document.querySelectorAll(sel)].map((s, i) => ({ i, n: s.textContent.trim().length, w: s.getBoundingClientRect().width }))
          .filter((x) => x.n >= 6 && x.w > 40).slice(0, 8).map((x) => x.i);
        return c.length ? c : false;
      }, righe, { timeout: 10000 }).catch(() => null);
      if (!trovati) throw new Error("nello strato di testo non c'è nessuna parola lunga");
      const candidati = await trovati.jsonValue();
      let scelto = "";
      let come = "";
      for (const i of candidati) {
        const riga = page.locator(righe).nth(i);
        await riga.scrollIntoViewIfNeeded();
        const b = await riga.boundingBox();
        if (!b) continue;
        const x0 = Math.round(b.x + 2), x1 = Math.round(b.x + b.width - 2), y = Math.round(b.y + b.height / 2);
        // il punto di partenza non deve essere coperto da una barra o da un pannello
        if (!(await page.evaluate(([x, yy]) => !!(document.elementFromPoint(x, yy) || {}).closest?.(".textLayer"), [x0, y]))) continue;
        await page.evaluate(() => getSelection().removeAllRanges());
        await page.mouse.move(x0, y);
        await page.mouse.down();
        await page.mouse.move(x1, y, { steps: 8 });
        await page.mouse.up();
        scelto = (await page.evaluate(() => getSelection().toString())).trim();
        come = "trascinando";
        if (!scelto) { // secondo tentativo: doppio clic su una parola
          await page.mouse.dblclick(Math.round(b.x + b.width / 2), y);
          scelto = (await page.evaluate(() => getSelection().toString())).trim();
          come = "doppio clic";
        }
        if (scelto) break;
      }
      if (!scelto) throw new Error("trascinando il mouse sul testo non si seleziona nulla");
      await page.screenshot({ path: SHOTS + `dispositivo-${d.id}.png` }).catch(() => {});
      return `${come}: «${scelto.slice(0, 30)}»${tocco ? " (dito simulato col mouse)" : ""}`;
    });
    // lo screenshot c'è anche se la selezione non è riuscita
    if (!fs.existsSync(SHOTS + `dispositivo-${d.id}.png`) || esiti.selezione !== "ok") await page.screenshot({ path: SHOTS + `dispositivo-${d.id}.png` }).catch(() => {});

    // 4. firma: apre il riquadro, scrive un nome, «Inserisci», «Fatto»
    let firmato = false;
    if (esiti.firma === undefined) await prova("firma", async () => {
      await tocca(page, "#btnSign");
      await page.waitForSelector(".sign-dialog[open]", { timeout: 10000 });
      await page.fill(".sign-dialog .sign-typed", "Mario Rossi");
      await tocca(page, ".sign-dialog .btn.primary");
      const editor = await page.waitForSelector(".stampEditor", { timeout: 10000 }).catch(() => { throw new Error("dopo «Inserisci» non compare l'editor della firma"); });
      await page.waitForTimeout(600);
      const b = await editor.boundingBox();
      if (!b || b.width < 10) throw new Error("l'editor della firma è senza dimensioni");
      firmato = true;
      await tocca(page, "#signDone");
      await page.waitForFunction(() => document.getElementById("signBar").hidden || getComputedStyle(document.getElementById("signBar")).display === "none", null, { timeout: 4000 })
        .catch(() => { throw new Error("«Fatto» non chiude la barra della firma"); });
      return `editor ${Math.round(b.width)}x${Math.round(b.height)} px`;
    });

    // 5. salva: scarica il documento (con la firma, se c'è) e il file è un PDF
    if (esiti.salva === undefined) await prova("salva", async () => {
      await page.evaluate(() => { const t = document.getElementById("toast"); t.hidden = true; t.textContent = ""; });
      const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), tocca(page, "#btnDownload")]);
      if (await dl.failure()) throw new Error("download fallito: " + (await dl.failure()));
      const file = await dl.path();
      if (!file) throw new Error("download senza file");
      const dati = fs.readFileSync(file);
      if (dati.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("il file scaricato non è un PDF");
      const toast = ((await page.textContent("#toast").catch(() => "")) || "").trim();
      if (/non riesce a scrivere la firma/i.test(toast)) throw new Error("il browser non scrive la firma nel PDF: " + toast.slice(0, 80));
      const originale = fs.statSync(ESEMPIO).size;
      const extra = firmato && dati.length <= originale ? " — ATTENZIONE: stessa dimensione dell'originale, la firma potrebbe mancare" : "";
      return `${dl.suggestedFilename()}, ${Math.round(dati.length / 1024)} KB${firmato ? " con firma" : ""}${extra}`;
    });
    await page.close().catch(() => {});

    // 6. OCR su una scansione (pagina nuova, nessuna modifica in sospeso)
    await prova("ocr", async () => {
      const p = await ctx.newPage();
      try {
        p.setDefaultTimeout(20000);
        watchErrors(p, errori);
        await p.goto(BASE, { waitUntil: "load" });
        const t0 = Date.now();
        await openFixture(p, "scansione.pdf");
        await p.waitForSelector(".page[data-page-number='1'] .ocrLayer span", { state: "attached", timeout: 60000 })
          .catch(() => { throw new Error("nessun testo OCR entro 60 s"); });
        const testo = await p.$$eval(".page[data-page-number='1'] .ocrLayer span", (ss) => ss.map((s) => s.textContent.trim()).filter(Boolean));
        if (!testo.some((t) => /[\p{L}\p{N}]/u.test(t))) throw new Error("l'OCR non ha letto nessuna parola");
        return `${testo.length} fasce in ${Math.round((Date.now() - t0) / 1000)} s («${testo.slice(0, 3).join(" ").slice(0, 40)}»)`;
      } finally {
        await p.close().catch(() => {});
      }
    });

    // 7. offline: dove il service worker funziona, si ferma il server, si ricarica e la pagina iniziale si apre
    await prova("offline", async () => {
      const octx = await browser.newContext({ ...opzioni, serviceWorkers: "allow" });
      try {
        const p = await octx.newPage();
        p.setDefaultTimeout(20000);
        const mancanti = [];
        p.on("requestfailed", (r) => mancanti.push(new URL(r.url()).pathname.replace(/^\/pdf\//, "")));
        await p.goto(BASE, { waitUntil: "load" });
        if (!(await p.evaluate(() => "serviceWorker" in navigator && window.isSecureContext))) nonProvato("service worker non disponibili in questo browser");
        const pronto = await p.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), 20000))]));
        if (!pronto) {
          if (d.browser === "chromium") throw new Error("il service worker non si attiva");
          nonProvato("il service worker non si attiva in questo browser emulato");
        }
        await p.reload({ waitUntil: "load" });
        await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 })
          .catch(() => { throw new Error("il service worker non prende il controllo della pagina"); });
        await server.ferma();
        mancanti.length = 0;
        await p.reload({ waitUntil: "load" }).catch((e) => { throw new Error("senza server la pagina non si ricarica: " + breve(e)); });
        const titolo = ((await p.textContent("#welcome h1").catch(() => "")) || "").trim();
        if (!/Apri un documento/.test(titolo)) throw new Error("offline la pagina iniziale non si apre");
        // e il lettore lavora: un PDF si apre anche senza rete (pdf.js e il suo worker sono in cache)
        await apriFile(p, ESEMPIO).catch(() => { throw new Error("offline la pagina si apre ma il PDF no"); });
        return mancanti.length ? `server spento: pagina e PDF si aprono; fuori dalla cache: ${[...new Set(mancanti)].slice(0, 4).join(", ")}` : "server spento: pagina e PDF si aprono";
      } finally {
        await server.avvia().catch((e) => { throw new Error("il server non riparte: " + breve(e)); });
        await octx.close().catch(() => {});
      }
    });

    // 8. manifest: apre i file PDF/P7M e riceve le condivisioni
    const p2 = await ctx.newPage();
    p2.setDefaultTimeout(20000);
    watchErrors(p2, errori);
    await p2.goto(BASE, { waitUntil: "load" }).catch(() => {});
    await prova("manifest", async () => {
      const m = await p2.evaluate(async () => {
        const l = document.querySelector('link[rel="manifest"]');
        if (!l) return { errore: "manca il <link rel=manifest>" };
        const r = await fetch(l.href);
        return r.ok ? await r.json() : { errore: "HTTP " + r.status };
      });
      if (m.errore) throw new Error(m.errore);
      if (!Array.isArray(m.file_handlers) || !m.file_handlers.length) throw new Error("manca file_handlers");
      if (!m.share_target || !m.share_target.action) throw new Error("manca share_target");
      return `file_handlers ${m.file_handlers.length}, share_target ${m.share_target.method || "GET"}`;
    });

    // 9. condividi: il pulsante c'è; senza Web Share compare il messaggio di copia del link
    await prova("condividi", async () => {
      if (!(await p2.isVisible("#btnShare"))) throw new Error("il pulsante Condividi non si vede");
      if (await p2.evaluate(() => typeof navigator.share === "function")) return "navigator.share presente (non invocato: aprirebbe il pannello di sistema)";
      await tocca(p2, "#btnShare");
      await p2.waitForSelector("#toast:not([hidden]), #shareMenu:not([hidden])", { timeout: 5000 })
        .catch(() => { throw new Error("senza navigator.share il clic non mostra né menu né avviso"); });
      const t = ((await p2.textContent("#toast").catch(() => "")) || "").trim();
      return `senza navigator.share: ${t ? "«" + t.slice(0, 45) + "»" : "menu aperto"}`;
    });

    check(`${d.nome}: nessun errore nella pagina`, errori.length === 0, errori.slice(0, 3).join(" | "));
    if (errori.length) note.push(`errori di pagina (${errori.length}): ${errori.slice(0, 2).map((e) => e.slice(0, 120)).join(" ; ")}`);
    if (errori.some((e) => /OffscreenCanvas/.test(e))) note.push("OffscreenCanvas manca in questo motore (come Safari prima di iOS/iPadOS 16.4): pdf.js se ne accorge quando si inserisce la firma e l'app salva il PDF senza firma, avvisando");
    await ctx.close().catch(() => {});
  } catch (e) {
    note.push("interrotto: " + breve(e));
    console.log(`✘ ${d.nome}: prova interrotta — ${breve(e)}`);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
  return fine();
}

function stampaTabella(prove) {
  const sigla = { ok: "ok", no: "NO", "non provato": "n.p." };
  const larg = Math.max(...prove.map((p) => p.dispositivo.length), 11);
  const colonne = PROVE.map((p) => Math.max(p.length, 4));
  const riga = (a, v) => a.padEnd(larg) + "  " + v.map((x, i) => x.padEnd(colonne[i])).join("  ");
  console.log(`\nC.A.R.T.A. ${versione} — prove su più dispositivi (emulati) del ${oggi}\n`);
  console.log(riga("Dispositivo", PROVE));
  console.log("-".repeat(larg + 2 + colonne.reduce((s, c) => s + c + 2, 0)));
  for (const p of prove) console.log(riga(p.dispositivo, PROVE.map((k) => sigla[p.esiti[k]])));
  console.log("\nok = riuscita · NO = non riuscita · n.p. = non provata (motivo nelle note)");
  console.log("\nNote:");
  for (const p of prove) console.log(`- ${p.dispositivo}: ${p.note || "—"}`);
}

(async () => {
  const guasti = controllaSintassi();
  if (guasti.length) console.log("⚠ errori di sintassi nei file del sito (le prove falliranno):\n  " + guasti.join("\n  "));
  const server = creaServer();
  await server.avvia();
  const prove = [];
  try {
    for (const d of DISPOSITIVI) prove.push(await provaDispositivo(d, server));
  } finally {
    server.chiudi();
  }
  stampaTabella(prove);
  const uscita = SHOTS + `dispositivi_${versione.replace(/[^\w.-]/g, "_")}.json`;
  fs.writeFileSync(uscita, JSON.stringify({ versione, data: oggi, prove }, null, 2) + "\n");
  console.log(`\nRapporto in ${uscita}\nScreenshot in ${SHOTS}dispositivo-<nome>.png`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
