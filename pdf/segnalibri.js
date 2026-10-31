// Segnalibri (31/10/2026): nel pannello accanto al PDF l'indice del documento (l'outline del PDF) e i segnalibri
// messi dall'utente. I segnalibri restano nel browser (IndexedDB), legati all'impronta SHA-256 dei byte del
// documento: lo stesso file riaperto li ritrova, un file diverso no. I titoli dell'indice vengono dal PDF: sempre
// come testo (h/textContent), mai come HTML.
import { h, icon } from "./dom.js";

const DB = "carta-segnalibri";
const STORE = "segnalibri";
const MAX_TITOLO = 120;

let els;
let ui; // { viewer: () => modulo viewer.js o null, toast }
let seq = 0; // apertura corrente: le letture asincrone di un documento chiuso nel frattempo si buttano
let chiave = null; // impronta del documento aperto
let pronto = null; // promessa: impronta calcolata e segnalibri letti
let elenco = []; // i segnalibri del documento aperto, in ordine di pagina
let specchi = new Set(); // impronte dei byte riscritti di questo documento (bozza, file salvato): si scrive anche lì
let indice = null; // { seq, voci } l'outline già letta, per non richiederla a ogni apertura del pannello
let paginaOra = 1;
let campo = null; // il campo del titolo, finché il pannello è disegnato
let listaMiei = null;

export function init(elements, hooks) {
  els = elements;
  ui = hooks;
  els.btnSegnalibri.addEventListener("click", () => mostra());
  els.segClose.addEventListener("click", () => mostra(false));
}

/** Documento PDF aperto: `bytes` sono quelli di partenza (doc.data), l'impronta è la loro. */
export function apri(bytes) {
  const s = ++seq;
  chiave = null;
  elenco = [];
  specchi = new Set();
  indice = null;
  pronto = (async () => {
    const k = await impronta(bytes);
    const letti = (await db("leggi", k)) || [];
    if (s !== seq) return;
    chiave = k;
    elenco = Array.isArray(letti) ? letti.filter(valido) : [];
  })();
  if (!els.segPanel.hidden) disegna();
}

/** Documento chiuso: il pannello si chiude e si dimentica tutto. */
export function chiudi() {
  ++seq;
  chiave = null;
  elenco = [];
  specchi = new Set();
  indice = null;
  pronto = null;
  mostra(false);
}

/** La pagina in vista è cambiata: il titolo proposto la segue. */
export function pagina(n) {
  paginaOra = n;
  if (campo) campo.placeholder = `Pagina ${n}`;
}

export function mostra(force) {
  const show = force ?? els.segPanel.hidden;
  els.segPanel.hidden = !show;
  els.btnSegnalibri.setAttribute("aria-expanded", String(show));
  if (show) {
    disegna();
    els.segClose.focus();
  }
}

/**
 * Salvato il documento con le annotazioni (o scritta la bozza), i byte cambiano e con loro l'impronta: i segnalibri
 * si copiano anche sotto quella nuova, così il file salvato (o la bozza ripresa) li ritrova. Si uniscono a quelli
 * già presenti là. Se i byte vecchi sono quelli del documento aperto, l'impronta nuova diventa uno specchio: i
 * segnalibri messi da ora in poi vanno anche lì, altrimenti si perderebbero riprendendo la bozza.
 */
export async function copiaPer(vecchiBytes, nuoviBytes) {
  try {
    if (!vecchiBytes || !nuoviBytes || vecchiBytes === nuoviBytes) return;
    await pronto;
    const [da, a] = await Promise.all([impronta(vecchiBytes), impronta(nuoviBytes)]);
    if (da === a) return;
    const aperto = da === chiave;
    if (aperto) specchi.add(a);
    const vecchi = aperto ? elenco : (await db("leggi", da)) || [];
    if (!vecchi.length) return;
    const nuovi = (await db("leggi", a)) || [];
    const uniti = [...nuovi];
    for (const s of vecchi) if (!uniti.some((x) => x.pagina === s.pagina && x.titolo === s.titolo)) uniti.push(s);
    ordina(uniti);
    await db("scrivi", a, uniti);
    if (aperto && uniti.length !== elenco.length) { // stessi byte già segnati un'altra volta: quei segnalibri sono di questo documento
      elenco = uniti;
      aggiornaMiei();
    }
  } catch (e) {
    console.warn("segnalibri:", e);
  }
}

/* --------------------------------------------------------------- Pannello */

async function disegna() {
  const s = seq;
  const V = ui.viewer();
  const pdf = V && V.documento();
  if (!pdf) {
    campo = listaMiei = null;
    els.segBody.replaceChildren(h("p", { class: "seg-niente" }, "Apri un PDF per vedere l'indice e i segnalibri."));
    return;
  }
  const [voci] = await Promise.all([leggiIndice(pdf, s), pronto]);
  if (s !== seq || els.segPanel.hidden) return;
  paginaOra = V.paginaCorrente(); // un documento nuovo parte da pagina 1 senza «pagechanging»: restava la pagina di quello prima

  const sezIndice = h("section", { class: "seg-sezione" }, h("h3", null, "Indice del documento"),
    voci && voci.length ? albero(voci, V, 0) : h("p", { class: "seg-niente" }, "Questo documento non ha un indice."));

  campo = h("input", { id: "segTitolo", type: "text", placeholder: `Pagina ${paginaOra}`, maxlength: MAX_TITOLO,
    "aria-label": "Nome del segnalibro", autocomplete: "off",
    onkeydown: (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        aggiungi();
      }
    } });
  listaMiei = h("ul", { class: "seg-miei", id: "segMiei" });
  const sezMiei = h("section", { class: "seg-sezione" }, h("h3", null, "I miei segnalibri"),
    h("div", { class: "seg-aggiungi" }, campo,
      h("button", { class: "btn", type: "button", id: "segAggiungi", title: "Segna la pagina che stai leggendo", onclick: aggiungi },
        icon("segnalibro"), h("span", null, "Aggiungi la pagina corrente"))),
    listaMiei,
    h("p", { class: "fill-hint seg-nota" }, "I segnalibri restano in questo browser e si ritrovano riaprendo lo stesso file."));
  els.segBody.replaceChildren(sezIndice, sezMiei);
  aggiornaMiei();
}

// L'outline del PDF (una volta per documento); se manca o non si legge, nessun indice.
async function leggiIndice(pdf, s) {
  if (indice && indice.seq === s) return indice.voci;
  let voci = null;
  try {
    voci = await pdf.getOutline();
  } catch {
    voci = null;
  }
  if (s === seq) indice = { seq: s, voci };
  return voci;
}

// L'albero dell'indice: i rami in <details> aperti, le foglie come pulsanti. Clic sul titolo = salto alla voce.
function albero(voci, V, livello) {
  return h("ul", { class: livello ? null : "seg-indice" }, voci.map((it) => {
    const titolo = String(it.title || "").replace(/\s+/g, " ").trim() || "(senza titolo)";
    let voce;
    if (it.dest) voce = h("button", { class: "seg-voce", type: "button", onclick: () => V.vaiDestinazione(it.dest) }, titolo);
    else if (it.url && /^https?:\/\//i.test(it.url)) voce = h("a", { class: "seg-voce", href: it.url, target: "_blank", rel: "noopener noreferrer nofollow" }, titolo);
    else voce = h("span", { class: "seg-voce" }, titolo);
    // oltre dieci livelli è un indice guasto: si ferma lì
    if (it.items && it.items.length && livello < 10) return h("li", null, h("details", { open: true }, h("summary", null, voce), albero(it.items, V, livello + 1)));
    return h("li", null, voce);
  }));
}

function aggiornaMiei() {
  if (!listaMiei) return;
  const V = ui.viewer();
  if (!elenco.length) {
    listaMiei.replaceChildren(h("li", { class: "seg-vuoto" }, "Nessun segnalibro: segna la pagina che stai leggendo."));
    return;
  }
  listaMiei.replaceChildren(...elenco.map((s) => h("li", null,
    h("button", { class: "seg-voce", type: "button", title: `Vai a pagina ${s.pagina}`, onclick: () => V && V.vaiPagina(s.pagina) },
      h("span", null, s.titolo), h("em", null, `pag. ${s.pagina} · ${quando(s.quando)}`)),
    h("button", { class: "btn icon-only seg-elimina", type: "button", title: "Elimina", "aria-label": `Elimina «${s.titolo}»`,
      onclick: () => elimina(s) }, icon("close")))));
}

async function aggiungi() {
  const V = ui.viewer();
  const n = V ? V.paginaCorrente() : paginaOra;
  const titolo = ((campo && campo.value.trim()) || `Pagina ${n}`).slice(0, MAX_TITOLO);
  await pronto;
  if (elenco.some((s) => s.pagina === n && s.titolo === titolo)) {
    ui.toast("Questa pagina ha già un segnalibro con questo nome.");
    return;
  }
  elenco.push({ pagina: n, titolo, quando: Date.now() });
  ordina(elenco);
  if (campo) campo.value = "";
  aggiornaMiei();
  await salva();
}

async function elimina(s) {
  const i = elenco.indexOf(s);
  if (i < 0) return;
  elenco.splice(i, 1);
  aggiornaMiei();
  await salva();
}

async function salva() {
  if (!chiave) return; // impronta non ancora pronta: non succede (aggiungi aspetta `pronto`), ma non si scrive a vuoto
  for (const k of [chiave, ...specchi]) {
    if (elenco.length) await db("scrivi", k, elenco);
    else await db("cancella", k);
  }
}

const ordina = (a) => a.sort((x, y) => x.pagina - y.pagina || x.quando - y.quando);
const valido = (s) => s && Number.isInteger(s.pagina) && s.pagina > 0 && typeof s.titolo === "string" && s.titolo;
const quando = (t) => new Date(t).toLocaleDateString("it-IT", { day: "numeric", month: "short" });

/* ----------------------------------------------------- Impronta e memoria */

async function impronta(bytes) {
  try {
    const d = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // senza crypto.subtle (pagina non sicura): un'impronta più debole, ma sempre la stessa per gli stessi byte
    let f = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) f = Math.imul(f ^ bytes[i], 16777619) >>> 0;
    return `fnv-${bytes.length}-${f.toString(16)}`;
  }
}

// Come la bozza in app.js: un archivio con chiave = impronta, valore = elenco. Ogni accesso in try/catch, perché in
// navigazione privata (o con lo spazio bloccato) IndexedDB può mancare: i segnalibri durano quanto la pagina.
const apriDb = () => new Promise((resolve, reject) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
async function db(modo, k, valore) {
  try {
    const d = await apriDb();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, modo === "leggi" ? "readonly" : "readwrite");
      tx.oncomplete = tx.onerror = tx.onabort = () => d.close();
      const t = tx.objectStore(STORE);
      const r = modo === "leggi" ? t.get(k) : modo === "scrivi" ? t.put(valore, k) : t.delete(k);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } catch {
    return null;
  }
}
