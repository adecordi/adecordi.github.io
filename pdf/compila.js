// «Compila»: manda il modulo PDF a un compilatore privato, che lo restituisce
// compilato. Il sito non contiene né l'indirizzo né la chiave del compilatore:
// si collegano una volta per dispositivo aprendo un link del compilatore stesso
// (…/pdf/#compilatore=<indirizzo>&chiave=<chiave>), e restano solo in questo browser.

import { h, icon } from "./dom.js";

const STORE = "lettore-compilatore";
const TIMEOUT = 180000;

// Indirizzi della rete locale: un compilatore lì può rispondere anche in http.
function isLocalHost(host) {
  return host === "localhost" || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

/**
 * Opzione di fetch per Chrome ed Edge: da una pagina https un indirizzo http della rete locale si
 * chiama solo dichiarandolo, «loopback» per questo stesso computer e «local» per gli altri.
 */
export function addressSpace(url) {
  const u = new URL(url);
  if (u.protocol !== "http:") return {};
  return { targetAddressSpace: /^(127\.|localhost$)/.test(u.hostname) ? "loopback" : "local" };
}

export function config() {
  try {
    const c = JSON.parse(localStorage.getItem(STORE) || "null");
    return c && c.url && c.chiave ? c : null;
  } catch {
    return null;
  }
}

/** Legge dal frammento dell'indirizzo il collegamento al compilatore. Vero se trovato. */
export function linkFromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const url = p.get("compilatore");
  const chiave = p.get("chiave");
  if (!url || !chiave) return false;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && !isLocalHost(u.hostname)) return false;
    localStorage.setItem(STORE, JSON.stringify({ url: u.href.replace(/\/$/, ""), chiave }));
    return true;
  } catch {
    return false;
  }
}

/**
 * «Apri in C.A.R.T.A.» (comando di iPad): il file è parcheggiato sul compilatore e il link porta
 * #ritira=<id>&da=<indirizzo>. L'id vale una volta sola e per pochi minuti, quindi non serve la chiave.
 * @returns {Promise<null | { bytes: Uint8Array, name: string }>}
 */
export async function pickupFromHash(ui) {
  const p = new URLSearchParams(location.hash.slice(1));
  const id = p.get("ritira");
  const from = p.get("da");
  if (!id || !from) return null;
  history.replaceState(null, "", location.pathname + location.search);
  let base;
  try {
    const u = new URL(from);
    if (u.protocol !== "https:" && !isLocalHost(u.hostname)) return null;
    base = u.href.replace(/\/$/, "");
  } catch {
    return null;
  }
  ui.busy("Ricevo il documento…");
  try {
    const res = await fetch(`${base}/ritira/${encodeURIComponent(id)}`, {
      ...addressSpace(base),
    });
    if (!res.ok) {
      const out = await res.json().catch(() => ({}));
      throw new Error(out.errore || `Il documento non è arrivato (${res.status}).`);
    }
    const name = decodeURIComponent(res.headers.get("X-Nome") || "documento.pdf");
    return { bytes: new Uint8Array(await res.arrayBuffer()), name };
  } catch (e) {
    ui.toast(e.name === "TypeError" ? "Non raggiungo il compilatore: serve Tailscale acceso." : e.message, "error");
    return null;
  } finally {
    ui.idle();
  }
}

export function unlink() {
  try {
    localStorage.removeItem(STORE);
  } catch { /* niente da fare */ }
}

let dialog = null;

// Chiede le istruzioni facoltative; null se annullato.
function askInstructions(name) {
  if (!dialog) {
    dialog = h("dialog", { class: "modal fill-dialog", "aria-labelledby": "fillTitle" },
      h("form", { method: "dialog" },
        h("h2", { id: "fillTitle" }, icon("wand"), " Compila con i miei dati"),
        h("p", { class: "fill-doc" }),
        h("p", { class: "fill-hint" }, "Il modulo va al tuo compilatore privato, che lo riempie con i dati che conosce e te lo restituisce da controllare. Firma, consensi e scelte personali restano a te."),
        h("label", { class: "fill-label", for: "fillNotes" }, "Istruzioni (facoltative)"),
        h("textarea", { id: "fillNotes", rows: 3, placeholder: "Es.: è per conto della Vinicola; come recapito usa la PEC" }),
        h("div", { class: "modal-actions" },
          h("button", { class: "btn", type: "submit", value: "cancel", formnovalidate: true }, "Annulla"),
          h("button", { class: "btn primary", type: "submit", value: "ok" }, "Compila"))));
    document.body.append(dialog);
  }
  dialog.querySelector(".fill-doc").textContent = name;
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok" ? dialog.querySelector("#fillNotes").value.trim() : null);
    }, { once: true });
    dialog.returnValue = "";
    dialog.showModal();
  });
}

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * @param {{ name: string, bytes: Uint8Array }} file modulo da compilare
 * @param {{ busy: Function, idle: Function, toast: Function }} ui
 * @returns {Promise<null | { bytes: Uint8Array, name: string, report: object }>}
 */
export async function compila(file, ui) {
  const cfg = config();
  if (!cfg) return null;
  const notes = await askInstructions(file.name);
  if (notes === null) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  ui.busy("Compilo il modulo… (può volerci un minuto)", { onCancel: () => ctrl.abort() });
  try {
    let res;
    try {
      res = await fetch(cfg.url + "/compila", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.chiave },
        body: JSON.stringify({ nome: file.name, pdf: toBase64(file.bytes), istruzioni: notes }),
        signal: ctrl.signal,
        // Chrome ed Edge: da una pagina https un indirizzo http della rete locale si può chiamare
        // solo dichiarandolo (e con il permesso «rete locale»). Gli altri browser ignorano l'opzione.
        ...addressSpace(cfg.url),
      });
    } catch (e) {
      if (e.name === "AbortError") throw new Error("Compilazione annullata.");
      // Chrome ed Edge chiedono il permesso per la rete locale: se è stato negato, la richiesta fallisce qui.
      const where = cfg.url.startsWith("http:") ? "essere collegati alla rete dell'ufficio" : "Tailscale acceso";
      throw new Error(`Compilatore non raggiungibile. Serve ${where} e, in Chrome o Edge, il permesso «accesso alla rete locale» per questo sito (icona a sinistra dell'indirizzo → Impostazioni sito).`);
    }
    const out = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("Il compilatore non riconosce questo dispositivo: ricollegalo dalla pagina del compilatore.");
    if (!res.ok || !out.pdf) throw new Error(out.errore || `Il compilatore ha risposto con un errore (${res.status}).`);
    const base = file.name.replace(/\.pdf$/i, "");
    return { bytes: fromBase64(out.pdf), name: `${base} (compilato).pdf`, report: out };
  } finally {
    clearTimeout(timer);
    ui.idle();
  }
}

/**
 * «Riassumi»: il testo delle pagine va al compilatore, che lo fa riassumere all'AI.
 * @returns {Promise<string>} il riassunto in Markdown semplice
 */
export async function riassumi(name, pages, ui) {
  const cfg = config();
  if (!cfg) throw new Error("Per riassumere collega prima il compilatore.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  ui.busy("Riassumo il documento… (di solito meno di un minuto)", { onCancel: () => ctrl.abort() });
  try {
    let res;
    try {
      res = await fetch(cfg.url + "/riassumi", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.chiave },
        body: JSON.stringify({ nome: name, pagine: pages }),
        signal: ctrl.signal,
        ...addressSpace(cfg.url),
      });
    } catch (e) {
      if (e.name === "AbortError") throw new Error("Riassunto annullato.");
      throw new Error("Compilatore non raggiungibile (serve la rete privata o quella dell'ufficio).");
    }
    const out = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("Il compilatore non riconosce questo dispositivo: ricollegalo.");
    if (!res.ok || !out.riassunto) throw new Error(out.errore || `Il compilatore ha risposto con un errore (${res.status}).`);
    return out.riassunto;
  } finally {
    clearTimeout(timer);
    ui.idle();
  }
}

// Markdown semplice (grassetto, elenchi, paragrafi) in nodi DOM: niente HTML dall'esterno.
function markdown(md) {
  const nodes = [];
  let list = null;
  const inline = (line) => {
    const p = [];
    line.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) p.push(h("strong", null, part.slice(2, -2)));
      else if (part) p.push(part);
    });
    return p;
  };
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    const m = /^[-*•]\s+(.*)$/.exec(line);
    if (m) {
      if (!list) nodes.push((list = h("ul", null)));
      list.append(h("li", null, inline(m[1])));
      continue;
    }
    list = null;
    if (line) nodes.push(h("p", null, inline(line)));
  }
  return nodes;
}

export function renderSummary(panel, body, md, name) {
  body.replaceChildren(
    h("p", { class: "fill-hint" }, `Riassunto di «${name}», scritto dall'AI: controlla i dati importanti sul documento.`),
    h("div", { class: "riassunto" }, markdown(md)),
    h("div", { class: "copy-actions" },
      h("button", { class: "btn", type: "button", onclick: async (e) => {
        try {
          await navigator.clipboard.writeText(md.replace(/\*\*/g, ""));
          e.target.textContent = "✓ Copiato";
        } catch {
          e.target.textContent = "Non riesco a copiare";
        }
      } }, "Copia il riassunto")));
  panel.hidden = false;
}

/** Riquadro con quello che è stato compilato e quello che resta da fare a mano. */
export function renderReport(panel, body, report) {
  const compilati = report.compilati || [];
  const mancanti = report.mancanti || [];
  body.replaceChildren(
    h("p", { class: "fill-summary" },
      compilati.length ? `${compilati.length} ${compilati.length === 1 ? "campo compilato" : "campi compilati"}` : "Nessun campo compilato",
      report.metodo === "posizioni" ? " (modulo senza campi: testo aggiunto sopra la pagina, puoi spostarlo)." : "."),
    h("p", { class: "fill-hint" }, "Controlla tutto prima di salvarlo o mandarlo."),
    mancanti.length ? h("section", null, h("h3", null, "Da completare a mano"),
      h("ul", { class: "fill-list todo" }, mancanti.map((m) =>
        h("li", null, h("strong", null, m.campo), m.motivo ? h("span", null, m.motivo) : null)))) : null,
    compilati.length ? h("section", null, h("h3", null, "Compilati"),
      h("ul", { class: "fill-list" }, compilati.map((c) =>
        h("li", null, h("strong", null, c.campo), h("span", null, String(c.valore)),
          c.pagina ? h("em", null, `pag. ${c.pagina}`) : null)))) : null);
  panel.hidden = false;
}
