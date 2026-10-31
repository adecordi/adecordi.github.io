// Lettura ad alta voce (31/10/2026) con la sintesi vocale del browser (Web Speech API, speechSynthesis): niente
// librerie, le voci sono quelle del dispositivo. Legge il documento dalla pagina in vista in poi («Leggi ad alta voce»
// nel menu «Altro») o il testo selezionato («Leggi» nel menu della selezione). Il testo va a frasi corte: Chrome
// tronca una frase che dura più di ~15 secondi. La frase in lettura si colora sulla pagina (ritrovata con trovaFrase,
// come i «Punti»); se non si ritrova si va avanti lo stesso.
// Su iOS la voce si sblocca solo se la prima speak() sta DENTRO il gestore del tocco: niente await prima.
import { h } from "./dom.js";

const CHIAVE_VELOCITA = "lettore-voce-velocita";
const VELOCITA = ["0.8", "1", "1.2"];
const MAX_FRASE = 200;
const MIN_FRASE = 20; // «Riga 1:» da solo non si capisce: un pezzo così corto va con quel che segue
// Senza l'elenco delle voci (Chrome lo dà solo dopo voiceschanged) la lingua basta: il browser sceglie lui.
const LINGUE = { en: "en-US", de: "de-DE", fr: "fr-FR", es: "es-ES" };

let els;
let ui; // { viewer: () => modulo viewer.js o null, pdf: () => documento PDF aperto o null, toast }
let voceMenu = null;
let serie = 0; // ogni frase ha il suo numero: gli eventi di una lettura fermata nel frattempo si ignorano
let lettura = null; // { frasi: [{ testo, pagina, view? }], i, pausa, velocita, lingua, utt }

const sintesi = () => window.speechSynthesis;

export function disponibile() {
  return !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
}

export function init(elements, hooks) {
  els = elements;
  ui = hooks;
  els.leggiVelocita.value = velocitaSalvata(); // da qui in poi fa fede la tendina (localStorage può mancare)
  els.leggiPausa.addEventListener("click", pausaRiprendi);
  els.leggiFerma.addEventListener("click", () => ferma());
  els.leggiVelocita.addEventListener("change", cambiaVelocita);
  if (disponibile()) sintesi().getVoices(); // Chrome comincia a caricare l'elenco solo alla prima richiesta
}

/** La voce nel menu «Altro»; `chiudi` è del menu. Senza sintesi vocale resta spenta, col perché nel titolo. */
export function vociMenu(menu, chiudi) {
  const ok = disponibile();
  voceMenu = h("button", { class: "share-option leggi-voce", type: "button", role: "menuitem", id: "voceLeggi",
    disabled: !ok, title: ok ? null : "Il browser non ha la sintesi vocale",
    onclick: () => {
      chiudi();
      leggiDocumento();
    } },
    h("strong", null, "Leggi ad alta voce"),
    h("span", null, ok ? "da questa pagina in poi" : "Il browser non ha la sintesi vocale"));
  menu.append(voceMenu);
}

/** Il menu «Altro» si sta aprendo: la voce vale solo per i PDF, e intanto si estrae il testo (così al tocco è pronto). */
export function prepara() {
  const V = ui.viewer();
  const pdf = ui.pdf();
  if (voceMenu && disponibile()) {
    voceMenu.disabled = !pdf;
    voceMenu.title = pdf ? "" : "Posso leggere ad alta voce solo i PDF";
  }
  if (V && pdf) V.documentText(pdf).catch(() => {});
}

export function attiva() {
  return !!lettura;
}

/** Dalla pagina in vista alla fine del documento. */
export function leggiDocumento() {
  if (!disponibile()) return;
  const V = ui.viewer();
  const pdf = ui.pdf();
  if (!V || !pdf) {
    ui.toast("Posso leggere ad alta voce solo i PDF.");
    return;
  }
  const da = V.paginaCorrente();
  const pronto = V.testoPronto(pdf);
  if (pronto) {
    avvia(frasiDocumento(pronto, da), V.linguaDocumento());
    return;
  }
  // Il testo va ancora estratto: su iOS la voce si sblocca solo dentro il tocco, quindi una frase vuota subito e
  // quelle vere appena il testo c'è. Se sta già leggendo la voce è sbloccata: si ferma e basta (una speak() subito
  // dopo cancel() su Chrome a volte non parte).
  const s = sintesi();
  if (lettura || s.speaking || s.pending) zittisci();
  else s.speak(new SpeechSynthesisUtterance(""));
  const attesa = ++serie;
  lettura = null;
  togliEvidenza();
  els.leggiStato.textContent = "Preparo il testo…";
  els.leggiBar.hidden = false;
  V.documentText(pdf).then((testi) => {
    if (serie !== attesa) return; // nel frattempo fermata, o partita un'altra lettura
    if (ui.pdf() !== pdf) return fine();
    avvia(frasiDocumento(testi, da), V.linguaDocumento());
  }).catch((e) => {
    if (serie !== attesa) return;
    fine();
    ui.toast(`Non riesco a leggere il testo: ${e && e.message ? e.message : e}`, "error");
  });
}

/** Il testo selezionato; `view` è la pagina della selezione, per colorare la frase. */
export function leggiTesto(testo, view = null) {
  if (!disponibile()) return;
  const V = ui.viewer();
  avvia(spezza(testo).map((t) => ({ testo: t, pagina: view ? view.id : 0, view })), V ? V.linguaDocumento() : null);
}

/** Ferma tutto (anche quando si chiude o si cambia documento): niente errori se non stava leggendo. */
export function ferma() {
  serie++;
  const s = disponibile() && sintesi();
  if (s && (lettura || s.speaking || s.pending || s.paused || !els.leggiBar.hidden)) zittisci();
  fine();
}

// Zittisce la voce e scarta gli eventi delle frasi in coda. Da una pausa prima si riprende: cancel() non la toglie
// (specifica Web Speech) e la lettura dopo partirebbe muta.
function zittisci() {
  serie++;
  const s = sintesi();
  if (s.paused) s.resume();
  s.cancel();
}

/* ------------------------------------------------------------ Lettura */

function avvia(frasi, lingua) {
  const s = sintesi();
  const interrotta = !!(lettura || s.speaking || s.pending);
  if (interrotta) zittisci(); // anche se non c'è niente da leggere: la frase in bocca non deve continuare senza barra
  if (!frasi.length) {
    fine();
    ui.toast("Non c'è testo da leggere: su una scansione prima «Riconosci il testo».");
    return;
  }
  const l = { frasi, i: 0, pausa: false, velocita: Number(velocitaScelta()), lingua, utt: null };
  lettura = l;
  els.leggiBar.hidden = false;
  aggiornaBarra();
  // Chrome: una speak() subito dopo cancel() a volte non parte. L'attesa va bene solo qui: la voce era già sbloccata,
  // non serve stare dentro il tocco (iOS).
  if (interrotta) setTimeout(() => { if (lettura === l) parla(0); }, 60);
  else parla(0);
}

function parla(i) {
  const l = lettura;
  if (!l) return;
  if (i >= l.frasi.length) return fine();
  l.i = i;
  const f = l.frasi[i];
  const id = ++serie;
  const u = new SpeechSynthesisUtterance(f.testo);
  const voce = scegliVoce(l.lingua);
  if (voce) u.voice = voce;
  u.lang = voce ? voce.lang : LINGUE[l.lingua] || "it-IT";
  u.rate = l.velocita;
  u.onend = () => {
    if (id === serie) parla(i + 1);
  };
  u.onerror = (e) => {
    if (id !== serie) return; // «interrupted» e «canceled» di una lettura fermata apposta: la serie è già cambiata
    const perche = e && e.error;
    fine();
    if (perche && perche !== "interrupted" && perche !== "canceled") ui.toast(`La lettura si è interrotta (${perche}).`, "error");
  };
  l.utt = u; // Chrome perde gli eventi di una frase che nessuno tiene più
  sintesi().speak(u);
  aggiornaBarra();
  evidenzia(f, id);
}

function fine() {
  lettura = null;
  togliEvidenza();
  els.leggiBar.hidden = true;
}

function pausaRiprendi() {
  if (!lettura) return;
  lettura.pausa = !lettura.pausa;
  if (lettura.pausa) sintesi().pause();
  else sintesi().resume();
  aggiornaBarra();
}

function cambiaVelocita() {
  const v = velocitaScelta();
  try {
    localStorage.setItem(CHIAVE_VELOCITA, v);
  } catch {
    // niente memoria (navigazione privata, spazio pieno): vale finché la pagina resta aperta, dalla tendina
  }
  const l = lettura;
  if (!l) return;
  // La velocità di una frase già in coda non si cambia: si riparte dalla frase in corso
  l.velocita = Number(v);
  l.pausa = false;
  const i = l.i;
  zittisci();
  setTimeout(() => {
    if (lettura === l) parla(i);
  }, 60); // Chrome: una speak() subito dopo cancel() a volte non parte
}

// La velocità vale quella nella tendina: localStorage serve solo a ricordarla alla prossima apertura.
function velocitaScelta() {
  return VELOCITA.includes(els.leggiVelocita.value) ? els.leggiVelocita.value : "1";
}

function velocitaSalvata() {
  let v = "1";
  try {
    v = localStorage.getItem(CHIAVE_VELOCITA) || "1";
  } catch {
    // come sopra
  }
  return VELOCITA.includes(v) ? v : "1";
}

function aggiornaBarra() {
  const l = lettura;
  if (!l) return;
  els.leggiStato.textContent = `frase ${l.i + 1} di ${l.frasi.length}`;
  els.leggiPausa.textContent = l.pausa ? "Riprendi" : "Pausa";
}

// La voce del documento se analizzaDocumento l'ha riconosciuto in un'altra lingua e il dispositivo ce l'ha,
// altrimenti italiano. Si sceglie a ogni frase: Chrome dà l'elenco vuoto finché non arriva voiceschanged, e la prima
// frase non può aspettarlo (iOS): parte con la sola lingua, le successive con la voce trovata.
function scegliVoce(lingua) {
  const voci = sintesi().getVoices() || [];
  const cerca = (l) => {
    const c = voci.filter((v) => String(v.lang || "").toLowerCase().replace("_", "-").startsWith(l));
    return c.find((v) => v.localService && v.default) || c.find((v) => v.localService) || c[0] || null;
  };
  return (lingua && lingua !== "it" && cerca(lingua)) || cerca("it") || null;
}

/* -------------------------------------------------------------- Frasi */

/**
 * Spezza un testo in frasi da leggere: ai segni di punteggiatura seguiti da uno spazio, non più di MAX_FRASE
 * caratteri (le frasi lunghe si tagliano a una virgola o a uno spazio).
 */
export function spezza(testo) {
  const pulito = String(testo || "").replace(/\s+/g, " ").trim();
  if (!pulito) return [];
  const pezzi = pulito.replace(/([.!?;:])\s+/g, "$1\n").split("\n").map((p) => p.trim()).filter(Boolean);
  const unite = [];
  let acc = "";
  for (const p of pezzi) {
    if (acc && acc.length < MIN_FRASE && acc.length + 1 + p.length <= MAX_FRASE) acc += " " + p;
    else {
      if (acc) unite.push(acc);
      acc = p;
    }
  }
  if (acc) unite.push(acc);
  const out = [];
  for (let f of unite) {
    while (f.length > MAX_FRASE) {
      let taglio = f.lastIndexOf(", ", MAX_FRASE);
      if (taglio >= MAX_FRASE / 2) taglio += 1; // la virgola resta con la frase prima
      else taglio = f.lastIndexOf(" ", MAX_FRASE);
      if (taglio < MAX_FRASE / 2) taglio = MAX_FRASE;
      out.push(f.slice(0, taglio).trim());
      f = f.slice(taglio).trim();
    }
    if (f) out.push(f);
  }
  return out;
}

// Le frasi di tutte le pagine da `da` in poi, ognuna con la sua pagina.
function frasiDocumento(testi, da) {
  const out = [];
  testi.forEach((t, i) => {
    if (i + 1 < da) return;
    for (const f of spezza(t)) out.push({ testo: f, pagina: i + 1 });
  });
  return out;
}

/* --------------------------------------------------- Frase sulla pagina */

function togliEvidenza() {
  document.querySelectorAll(".leggi-frase").forEach((e) => e.remove());
}

// Colora la frase sulla pagina e, se sta fuori dalla parte visibile, scorre fin lì. Se non si ritrova (scansione
// senza OCR, testo spezzato in modo diverso) si cambia pagina quando serve e basta.
async function evidenzia(f, id) {
  togliEvidenza();
  const V = ui.viewer();
  if (!V) return;
  const view = f.view || V.pageView(f.pagina - 1);
  let boxes = null;
  if (view && view.pdfPage && view.div) {
    try {
      boxes = await V.trovaFrase(view, f.testo);
    } catch {
      boxes = null;
    }
  }
  if (id !== serie) return;
  if (!boxes) {
    if (!f.view && f.pagina && V.paginaCorrente() !== f.pagina) V.vaiPagina(f.pagina);
    return;
  }
  // i riquadri sono frazioni della pagina non ruotata, dall'alto (come in trovaFrase): in pixel passando per le
  // coordinate PDF e il viewport, che sa di zoom e rotazione (come markParts in testo.js)
  const [vx0, vy0, vx1, vy1] = view.pdfPage.view;
  const W = vx1 - vx0;
  const H = vy1 - vy0;
  let primo = null;
  for (const b of boxes) {
    const [ax, ay] = view.viewport.convertToViewportPoint(vx0 + b.x * W, vy1 - b.y * H);
    const [bx, by] = view.viewport.convertToViewportPoint(vx0 + (b.x + b.width) * W, vy1 - (b.y + b.height) * H);
    const d = h("div", { class: "leggi-frase" });
    Object.assign(d.style, {
      left: `${Math.min(ax, bx)}px`, top: `${Math.min(ay, by)}px`,
      width: `${Math.abs(bx - ax)}px`, height: `${Math.abs(by - ay)}px`,
    });
    view.div.append(d);
    primo = primo || d;
  }
  if (primo) portaInVista(primo);
}

function portaInVista(d) {
  const c = els.viewerContainer;
  const r = d.getBoundingClientRect();
  const cr = c.getBoundingClientRect();
  if (r.top >= cr.top + 8 && r.bottom <= cr.bottom - 8) return;
  c.scrollTo({ top: c.scrollTop + (r.top - cr.top) - cr.height * 0.4, behavior: "smooth" });
}
