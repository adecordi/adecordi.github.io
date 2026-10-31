// «Leggi ad alta voce» (31/10/2026): la sintesi vocale è finta (Chromium senza audio non ha voci), così si controlla
// cosa arriva a speechSynthesis: frasi corte dalla pagina in vista, la barra in basso, la frase colorata sulla pagina,
// Pausa/Riprendi, Ferma, la velocità ricordata, «Leggi» nel menu della selezione, lo stop al cambio di documento e
// la voce spenta quando il browser non ha la sintesi vocale.
const { chromium } = require("playwright");
const { SHOTS, BASE, check, watchErrors, openFixture, text } = require("./common.cjs");

const PAGINA1 = ".page[data-page-number='1'] .textLayer span";

// Il finto speechSynthesis: speak() mette il testo in window.__parlato (e l'ultima frase in window.__ultima) e manda
// start/end in modo asincrono (una frase «dura» 250 ms, in pausa non finisce); cancel() svuota la coda; cancel, pause
// e resume si registrano in window.__chiamate; getVoices() dà una voce italiana.
function fintaSintesi() {
  window.__parlato = [];
  window.__chiamate = [];
  window.__ultima = null;
  const manda = (u, tipo) => {
    const ev = new Event(tipo);
    if (typeof u["on" + tipo] === "function") u["on" + tipo](ev);
    u.dispatchEvent(ev);
  };
  class FintaUtterance extends EventTarget {
    constructor(testo) {
      super();
      this.text = testo == null ? "" : String(testo);
      this.lang = "";
      this.voice = null;
      this.rate = 1;
      this.pitch = 1;
      this.volume = 1;
      this.onstart = null;
      this.onend = null;
      this.onerror = null;
    }
  }
  const S = {
    speaking: false, paused: false, pending: false, onvoiceschanged: null,
    _coda: [], _corrente: null, _timer: 0,
    addEventListener() {},
    removeEventListener() {},
    getVoices() {
      return [{ lang: "it-IT", name: "Prova", localService: true, default: true, voiceURI: "Prova" }];
    },
    speak(u) {
      if (u.text) { // la frase vuota di sblocco (iOS) non conta
        window.__parlato.push(u.text);
        window.__ultima = u;
      }
      this._coda.push(u);
      this._avanti();
    },
    _avanti() {
      this.pending = this._coda.length > 0;
      if (this._corrente || !this._coda.length) return;
      const u = (this._corrente = this._coda.shift());
      this.pending = this._coda.length > 0;
      this.speaking = true;
      setTimeout(() => {
        if (this._corrente !== u) return;
        manda(u, "start");
        this._fine(u, u.text ? 250 : 10);
      }, 20);
    },
    _fine(u, ms) {
      this._timer = setTimeout(() => {
        if (this._corrente !== u) return;
        if (this.paused) return this._fine(u, 100);
        this._corrente = null;
        this.speaking = false;
        manda(u, "end");
        this._avanti();
      }, ms);
    },
    cancel() {
      window.__chiamate.push("cancel");
      clearTimeout(this._timer);
      const u = this._corrente;
      this._corrente = null;
      this._coda = [];
      this.speaking = false;
      this.pending = false;
      this.paused = false;
      if (u) manda(u, "end"); // come Chrome: la frase interrotta finisce
    },
    pause() {
      window.__chiamate.push("pause");
      this.paused = true;
    },
    resume() {
      window.__chiamate.push("resume");
      this.paused = false;
    },
  };
  Object.defineProperty(window, "speechSynthesis", { value: S, configurable: true, writable: true });
  window.SpeechSynthesisUtterance = FintaUtterance;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.addInitScript(fintaSintesi);
  const errors = [];
  watchErrors(page, errors);
  const parlato = () => page.evaluate(() => window.__parlato.slice());
  const chiamate = (c) => page.evaluate((c) => window.__chiamate.filter((x) => x === c).length, c);
  const evidenziate = () => page.$$eval(".leggi-frase", (e) => e.length);
  // Dopo un cambio di spazio la pagina si ridisegna: si aspetta il testo nuovo (come in annota.cjs).
  const span = async (re) => {
    for (let i = 0; i < 40; i++) {
      for (const s of await page.$$(PAGINA1)) {
        if (re.test(await s.textContent())) {
          const bb = await s.boundingBox();
          if (bb) return bb;
        }
      }
      await page.waitForTimeout(150);
    }
    return null;
  };
  const seleziona = async (re) => {
    const r = await span(re);
    await page.mouse.move(r.x + 1, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width - 1, r.y + r.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForSelector(".copy-pill:not([hidden])");
  };

  await page.goto(BASE);
  await openFixture(page, "doc.pdf");
  await page.waitForSelector(PAGINA1);
  check("la barra di lettura parte nascosta", await page.isHidden("#leggiBar"));

  // --- dal menu «Altro», dalla pagina in vista in poi
  await page.click("#btnAltro");
  await page.waitForSelector("#menuAltro:not([hidden])");
  check("nel menu «Altro» c'è «Leggi ad alta voce», attiva", await page.isVisible("#voceLeggi") && !(await page.isDisabled("#voceLeggi")));
  await page.screenshot({ path: SHOTS + "leggi-menu.png" });
  await page.click("#voceLeggi");
  check("il menu si chiude", await page.isHidden("#menuAltro"));
  await page.waitForFunction(() => window.__parlato.length >= 3, null, { timeout: 8000 });
  await page.waitForSelector(".leggi-frase", { timeout: 5000 });
  const frasi = await parlato();
  check("legge una frase dopo l'altra", frasi.length >= 3, String(frasi.length));
  check("nessuna frase oltre 220 caratteri", frasi.every((f) => f.length <= 220), `la più lunga: ${Math.max(...frasi.map((f) => f.length))}`);
  check("la prima frase è l'inizio della pagina 1", /Documento di prova/.test(frasi[0]), frasi[0]);
  check("in italiano, a velocità normale", /^it/.test(await page.evaluate(() => window.__ultima.lang)) && (await page.evaluate(() => window.__ultima.rate)) === 1);
  check("la barra dice a che frase è", await page.isVisible("#leggiBar") && /^frase \d+ di \d+$/.test(await text(page, "#leggiStato")), await text(page, "#leggiStato"));
  check("la frase in lettura è colorata sulla pagina", (await evidenziate()) >= 1);
  await page.screenshot({ path: SHOTS + "leggi-barra.png" });

  // --- Pausa e Riprendi
  await page.click("#leggiPausa");
  check("Pausa chiama pause() e diventa «Riprendi»", (await chiamate("pause")) === 1 && (await text(page, "#leggiPausa")) === "Riprendi");
  const prima = (await parlato()).length;
  await page.waitForTimeout(700);
  check("in pausa non va avanti", (await parlato()).length === prima);
  await page.click("#leggiPausa");
  check("Riprendi chiama resume()", (await chiamate("resume")) === 1 && (await text(page, "#leggiPausa")) === "Pausa");
  await page.waitForFunction((n) => window.__parlato.length > n, prima, { timeout: 5000 });

  // --- velocità: ricordata, e vale dalla frase in corso
  await page.selectOption("#leggiVelocita", "1.2");
  await page.waitForTimeout(300);
  check("la velocità si ricorda", (await page.evaluate(() => localStorage.getItem("lettore-voce-velocita"))) === "1.2");
  check("e vale già per la frase in corso", (await page.evaluate(() => window.__ultima.rate)) === 1.2);

  // --- Ferma
  const cancelPrima = await chiamate("cancel");
  await page.click("#leggiFerma");
  check("Ferma chiama cancel()", (await chiamate("cancel")) > cancelPrima);
  check("e la barra sparisce", await page.isHidden("#leggiBar"));
  check("senza più frasi colorate", (await evidenziate()) === 0);
  const dopoFerma = (await parlato()).length;
  await page.waitForTimeout(600);
  check("e non legge altro", (await parlato()).length === dopoFerma);

  // --- «Leggi» nel menu della selezione
  await page.evaluate(() => (window.__parlato = []));
  await seleziona(/Riga 2/);
  check("nel menu della selezione c'è «Leggi»", await page.isVisible(".copy-pill [data-a='leggi']"));
  await page.click(".copy-pill [data-a='leggi']");
  await page.waitForFunction(() => window.__parlato.length >= 1, null, { timeout: 5000 });
  check("«Leggi» legge il testo selezionato", /Riga 2/.test((await parlato())[0]), (await parlato())[0]);
  check("con la barra", await page.isVisible("#leggiBar"));
  await page.waitForSelector(".leggi-frase", { timeout: 5000 });
  check("e la riga colorata", (await evidenziate()) >= 1);
  await page.screenshot({ path: SHOTS + "leggi-selezione.png" });
  await page.waitForFunction(() => document.getElementById("leggiBar").hidden, null, { timeout: 5000 });
  check("finita la frase, la barra si chiude da sola", await page.isHidden("#leggiBar") && (await evidenziate()) === 0);

  // --- Escape ferma; cambiare documento ferma
  await page.click("#btnAltro");
  await page.click("#voceLeggi");
  await page.waitForSelector("#leggiBar:not([hidden])");
  await page.keyboard.press("Escape");
  check("Escape ferma la lettura", await page.isHidden("#leggiBar"));
  await page.click("#btnAltro");
  await page.click("#voceLeggi");
  await page.waitForSelector("#leggiBar:not([hidden])");
  const cancelPrimaDoc = await chiamate("cancel");
  await openFixture(page, "indice.pdf");
  await page.waitForSelector(PAGINA1);
  check("cambiando documento la voce si ferma", (await chiamate("cancel")) > cancelPrimaDoc && (await page.isHidden("#leggiBar")));
  check("nessun errore nella pagina", !errors.length, errors.join(" | "));

  // --- browser senza sintesi vocale: la voce del menu è spenta col perché, «Leggi» non c'è nella selezione
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
  const p2 = await ctx2.newPage();
  await p2.addInitScript(() => {
    Object.defineProperty(window, "speechSynthesis", { value: undefined, configurable: true, writable: true });
  });
  const errors2 = [];
  watchErrors(p2, errors2);
  await p2.goto(BASE);
  await openFixture(p2, "doc.pdf");
  await p2.waitForSelector(PAGINA1);
  await p2.click("#btnAltro");
  await p2.waitForSelector("#menuAltro:not([hidden])");
  check("senza sintesi vocale la voce è spenta", await p2.isDisabled("#voceLeggi"));
  check("col perché nel titolo", (await p2.getAttribute("#voceLeggi", "title")) === "Il browser non ha la sintesi vocale", await p2.getAttribute("#voceLeggi", "title"));
  await p2.keyboard.press("Escape");
  const r = await (async () => {
    for (let i = 0; i < 40; i++) {
      for (const s of await p2.$$(PAGINA1)) {
        if (/Riga 3/.test(await s.textContent())) {
          const bb = await s.boundingBox();
          if (bb) return bb;
        }
      }
      await p2.waitForTimeout(150);
    }
    return null;
  })();
  await p2.mouse.move(r.x + 1, r.y + r.height / 2);
  await p2.mouse.down();
  await p2.mouse.move(r.x + r.width - 1, r.y + r.height / 2, { steps: 8 });
  await p2.mouse.up();
  await p2.waitForSelector(".copy-pill:not([hidden])");
  check("e nel menu della selezione «Leggi» non c'è", await p2.isHidden(".copy-pill [data-a='leggi']"));
  check("nessun errore nemmeno lì", !errors2.length, errors2.join(" | "));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
