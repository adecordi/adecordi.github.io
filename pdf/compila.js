// «Compila»: manda il modulo PDF a un compilatore privato, che lo restituisce
// compilato. Il sito non contiene né l'indirizzo né la chiave del compilatore:
// si collegano una volta per dispositivo aprendo un link del compilatore stesso
// (…/pdf/#compilatore=<indirizzo>&chiave=<chiave>), e restano solo in questo browser.

import { h, icon } from "./dom.js";

const STORE = "lettore-compilatore";
const TIMEOUT = 180000;

// Indirizzi della rete locale: un compilatore lì può rispondere anche in http.
function isLocalHost(host) {
  if (host === "localhost") return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ip || ip.slice(1).some((n) => Number(n) > 255)) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
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
    if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocalHost(u.hostname))) return false;
    const prima = config();
    const nuovo = u.href.replace(/\/$/, "");
    if (prima && prima.url !== nuovo
      && !confirm(`Questo link collega C.A.R.T.A. a un altro compilatore:\n${u.host}\n\nAl posto di ${new URL(prima.url).host}. `
        + "I documenti da compilare, riassumere o spiegare andranno lì. Continuo?")) return false;
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
const CHI = "lettore-chi-compila";

// Chiede le istruzioni facoltative; null se annullato.
function askInstructions(name) {
  if (!dialog) {
    dialog = h("dialog", { class: "modal fill-dialog", "aria-labelledby": "fillTitle" },
      h("form", { method: "dialog" },
        h("h2", { id: "fillTitle" }, icon("wand"), " Compila con i miei dati"),
        h("p", { class: "fill-doc" }),
        h("p", { class: "fill-hint" }, "Il modulo va al tuo compilatore privato, che lo riempie con i dati che conosce e te lo restituisce da controllare. Firma, consensi e scelte personali restano a te."),
        // Quali dati usa il compilatore: solo la scheda scelta va all'AI (30/10/2026).
        h("fieldset", { class: "fill-who" },
          h("legend", { class: "fill-label" }, "A nome di chi?"),
          [["personale", "Personale", "i miei dati privati"],
           ["azienda", "Azienda", "i dati della Vinicola"],
           ["azienda_io", "Azienda, firmo io", "la Vinicola, con me come firmatario"]].map(([v, t, d]) =>
            h("label", { class: "fill-who-opt" },
              h("input", { type: "radio", name: "fillWho", value: v, required: true }),
              h("span", null, h("strong", null, t), h("small", null, d))))),
        // Chi sta compilando: per l'azienda è il referente da proporre (Alessandro, 30/10/2026).
        h("label", { class: "fill-label", for: "fillChi" }, "Chi compila"),
        h("input", { id: "fillChi", class: "fill-chi", type: "text", autocomplete: "name", placeholder: "Nome e cognome" }),
        h("label", { class: "fill-label", for: "fillNotes" }, "Istruzioni (facoltative)"),
        h("textarea", { id: "fillNotes", rows: 3, placeholder: "Es.: come recapito usa la PEC; l'IBAN è quello di Intesa" }),
        h("div", { class: "modal-actions" },
          h("button", { class: "btn", type: "submit", value: "cancel", formnovalidate: true }, "Annulla"),
          h("button", { class: "btn primary", type: "submit", value: "ok" }, "Compila"))));
    document.body.append(dialog);
  }
  dialog.querySelector(".fill-doc").textContent = name;
  const chi = dialog.querySelector("#fillChi");
  try {
    chi.value = localStorage.getItem(CHI) || "";
  } catch { /* senza memoria si riscrive */ }
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const who = dialog.querySelector("input[name=fillWho]:checked");
      const nomeChi = chi.value.trim();
      if (dialog.returnValue === "ok") {
        try {
          localStorage.setItem(CHI, nomeChi);
        } catch { /* niente da fare */ }
      }
      resolve(dialog.returnValue === "ok"
        ? { notes: dialog.querySelector("#fillNotes").value.trim(), profilo: who ? who.value : null, chi: nomeChi } : null);
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
let ultima = null; // { file, notes, profilo }: per ricompilare con i dati trovati

export async function compila(file, ui) {
  const cfg = config();
  if (!cfg) return null;
  const scelta = await askInstructions(file.name);
  if (scelta === null) return null;
  const { profilo, chi } = scelta;
  // Per l'azienda chi compila è il referente o la persona di contatto da proporre.
  const notes = [chi && profilo !== "personale"
    ? `Chi compila il modulo: ${chi}. Nei campi «referente», «persona di contatto», «compilato da» o simili proponi questo nome.`
    : "", scelta.notes].filter(Boolean).join("\n");
  ultima = { file, notes, profilo };
  return invia(file, notes, profilo, ui);
}

/** Ricompila il modulo originale aggiungendo alle istruzioni i dati trovati («campo: valore»). */
export async function ricompila(dati, ui) {
  if (!ultima) throw new Error("Non trovo il modulo di partenza: riapri il PDF e ricompila.");
  const righe = dati.map((d) => `- ${d.campo}: ${d.valore}`).join("\n");
  ultima.notes = [ultima.notes, "Dati trovati e confermati dall'utente, da usare nei campi indicati:\n" + righe].filter(Boolean).join("\n");
  return invia(ultima.file, ultima.notes, ultima.profilo, ui);
}

/** «Cercalo»: un dato mancante cercato dal compilatore in Files Comuni, OneDrive e posta. */
export async function cercaDato(campo, motivo) {
  const cfg = config();
  if (!cfg) throw new Error("Per cercare collega prima il compilatore.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    let res;
    try {
      res = await fetch(cfg.url + "/cerca", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.chiave },
        body: JSON.stringify({ campo, motivo, nome: ultima ? ultima.file.name : "", profilo: ultima ? ultima.profilo : null }),
        signal: ctrl.signal,
        ...addressSpace(cfg.url),
      });
    } catch (e) {
      throw new Error(e.name === "AbortError" ? "Ricerca troppo lunga: riprova." : "Compilatore non raggiungibile.");
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.errore || `Il compilatore ha risposto con un errore (${res.status}).`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function invia(file, notes, profilo, ui) {
  const cfg = config();
  if (!cfg) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  ui.busy("Compilo il modulo… (può volerci un minuto)", { onCancel: () => ctrl.abort() });
  try {
    let res;
    try {
      res = await fetch(cfg.url + "/compila", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.chiave },
        body: JSON.stringify({ nome: file.name, pdf: toBase64(file.bytes), istruzioni: notes, profilo }),
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

/**
 * «Spiega»: un pezzo selezionato (testo) o un ritaglio (PNG in base64) va al compilatore,
 * con il testo della pagina come contesto, e l'AI lo spiega.
 * @returns {Promise<string>} la spiegazione in Markdown semplice
 */
export async function spiega(name, req, ui) {
  const cfg = config();
  if (!cfg) throw new Error("Per farti spiegare un pezzo collega prima il compilatore.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  ui.busy(req.compito === "traduci" ? "L'AI traduce il pezzo selezionato…"
    : req.png ? "L'AI guarda il ritaglio… (di solito meno di un minuto)" : "L'AI legge il pezzo selezionato…",
    { onCancel: () => ctrl.abort() });
  try {
    let res;
    try {
      res = await fetch(cfg.url + "/spiega", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.chiave },
        body: JSON.stringify({ nome: name, testo: req.testo || "", png: req.png || "", contesto: req.contesto || "", compito: req.compito || "spiega" }),
        signal: ctrl.signal,
        ...addressSpace(cfg.url),
      });
    } catch (e) {
      if (e.name === "AbortError") throw new Error("Spiegazione annullata.");
      throw new Error("Compilatore non raggiungibile (serve la rete privata o quella dell'ufficio).");
    }
    const out = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("Il compilatore non riconosce questo dispositivo: ricollegalo.");
    if (!res.ok || !out.spiegazione) throw new Error(out.errore || `Il compilatore ha risposto con un errore (${res.status}).`);
    return out.spiegazione;
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

export function renderSummary(panel, body, md, name, kind = "riassunto") {
  const spiega = kind === "spiega";
  const traduci = kind === "traduci";
  const title = panel.querySelector("h2");
  if (title) title.textContent = traduci ? "Traduzione" : spiega ? "Spiegazione" : "Riassunto";
  body.replaceChildren(
    h("p", { class: "fill-hint" }, traduci
      ? `Traduzione dell'AI di un pezzo di «${name}»: per un uso ufficiale serve una traduzione verificata.`
      : spiega
        ? `Spiegazione dell'AI di un pezzo di «${name}»: è un aiuto a capire, il testo che vale è quello del documento.`
        : `Riassunto di «${name}», scritto dall'AI: controlla i dati importanti sul documento.`),
    h("div", { class: "riassunto" }, markdown(md)),
    h("div", { class: "copy-actions" },
      h("button", { class: "btn", type: "button", onclick: async (e) => {
        try {
          await navigator.clipboard.writeText(md.replace(/\*\*/g, ""));
          e.target.textContent = "✓ Copiato";
        } catch {
          e.target.textContent = "Non riesco a copiare";
        }
      } }, traduci ? "Copia la traduzione" : spiega ? "Copia la spiegazione" : "Copia il riassunto")));
  panel.hidden = false;
}

/** Riquadro con quello che è stato compilato e quello che resta da fare a mano. */
export function renderReport(panel, body, report, azioni = {}) {
  const compilati = report.compilati || [];
  const mancanti = report.mancanti || [];
  // Dati scritti o trovati e già inseriti nel PDF: alla fine si chiede se tenerli in cassaforte.
  const inseriti = [];
  const salva = h("div", { class: "fill-salva", hidden: true });
  const chiediSalva = () => {
    if (!inseriti.length) {
      salva.hidden = true;
      return;
    }
    const n = inseriti.length;
    salva.replaceChildren(
      h("p", null, `Salvo ${n === 1 ? "questo dato" : `questi ${n} dati`} in cassaforte, così la prossima volta li compilo io?`),
      h("div", { class: "modal-actions" },
        h("button", { class: "btn primary", type: "button", onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const r = await ricorda(inseriti.splice(0));
            salva.replaceChildren(h("p", null, `✓ Salvati in cassaforte (${r.aggiunti}): li userò dalla prossima compilazione.`));
          } catch (err) {
            salva.replaceChildren(h("p", null, err.message || String(err)));
          }
        } }, "Sì, salvali"),
        h("button", { class: "btn", type: "button", onclick: () => {
          inseriti.splice(0);
          salva.hidden = true;
        } }, "No")));
    salva.hidden = false;
  };
  // Mette il valore nel PDF: nel campo giusto se il compilatore l'ha indicato, altrimenti ricompilando con quel dato.
  const metti = async (m, valore, stato) => {
    if (m.pdf_campo && azioni.imposta && await azioni.imposta(m.pdf_campo, valore)) {
      stato.replaceChildren(h("span", { class: "fill-ok" }, "✓ inserito: "), h("span", { class: "fill-value" }, valore));
      inseriti.push({ campo: m.campo, valore });
      chiediSalva();
      return;
    }
    // Il posto non si sa: si ricompila subito con questo dato (il pannello si rinnova).
    if (azioni.inserisci) await azioni.inserisci([{ campo: m.campo, valore }]);
  };
  const voce = (m) => {
    const stato = h("div", { class: "fill-found" });
    if (/firm/i.test(m.campo)) {
      return h("li", null, h("strong", null, m.campo), m.motivo ? h("span", null, m.motivo) : null,
        h("div", { class: "fill-actions" },
          h("button", { class: "btn", type: "button", onclick: () => azioni.firma && azioni.firma() }, "Firma ora")), stato);
    }
    if (m.tipo === "casella" && m.pdf_campo) {
      let spuntata = false;
      const b = h("button", { class: "btn", type: "button", onclick: async () => {
        spuntata = !spuntata;
        if (await azioni.imposta(m.pdf_campo, spuntata)) b.textContent = spuntata ? "Togli la spunta" : "Spunta";
      } }, "Spunta");
      return h("li", null, h("strong", null, m.campo), m.motivo ? h("span", null, m.motivo) : null,
        h("div", { class: "fill-actions" }, b,
          h("button", { class: "btn", type: "button", onclick: () => azioni.mostra(m.pdf_campo) }, "Mostra nel modulo")),
        h("small", null, "Puoi anche cliccare direttamente il quadratino sul modulo."), stato);
    }
    // «Lo scrivo io»: una casella qui sotto, e con «Inserisci» il valore va subito nel modulo.
    const scrivi = h("form", { class: "fill-scrivi", hidden: true, onsubmit: async (e) => {
      e.preventDefault();
      const valore = scrivi.querySelector("input").value.trim();
      if (!valore) return;
      scrivi.hidden = true;
      await metti(m, valore, stato);
    } },
      h("input", { type: "text", placeholder: m.campo, "aria-label": m.campo }),
      h("button", { class: "btn primary", type: "submit" }, "Inserisci"));
    const bottoni = h("div", { class: "fill-actions" },
      h("button", { class: "btn", type: "button", onclick: () => {
        if (!m.pdf_campo) return azioni.scrivoIo && azioni.scrivoIo(); // posto sconosciuto: una nota sulla pagina
        scrivi.hidden = false;
        scrivi.querySelector("input").focus();
        azioni.mostra && azioni.mostra(m.pdf_campo);
      } }, "Lo scrivo io"),
      h("button", { class: "btn", type: "button", onclick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        stato.replaceChildren(h("span", { class: "fill-wait" }, "Cerco in Files Comuni, OneDrive e posta… (circa un minuto)"));
        try {
          const r = await cercaDato(m.campo, m.motivo || "");
          if (!r.trovato) {
            stato.replaceChildren(h("span", null, "Non trovato. ", r.nota || ""));
            b.disabled = false;
            return;
          }
          stato.replaceChildren(
            h("span", { class: "fill-value" }, r.valore),
            h("small", null, `Fonte: ${r.fonte || "?"} · certezza ${r.certezza || "?"}`),
            r.nota ? h("small", null, r.nota) : null,
            h("button", { class: "btn primary", type: "button", onclick: () => metti(m, r.valore, stato) }, "Inserisci"));
        } catch (err) {
          stato.replaceChildren(h("span", null, err.message || String(err)));
          b.disabled = false;
        }
      } }, "Cercalo"));
    return h("li", null, h("strong", null, m.campo), m.motivo ? h("span", null, m.motivo) : null, bottoni, scrivi, stato);
  };
  body.replaceChildren(
    h("p", { class: "fill-summary" },
      compilati.length ? `${compilati.length} ${compilati.length === 1 ? "campo compilato" : "campi compilati"}` : "Nessun campo compilato",
      report.metodo === "posizioni" ? " (modulo senza campi: ho aggiunto i campi sopra la pagina)." : "."),
    h("p", { class: "fill-hint" }, "In blu, a macchina da scrivere, quello che ho scritto io: puoi correggerlo cliccandoci. Gli spazi vuoti e i quadratini si compilano cliccandoci sopra."),
    mancanti.length ? h("section", null, h("h3", null, "Da completare"),
      h("p", { class: "fill-hint" }, "Scrivilo tu o lo cerco io nei Files Comuni, su OneDrive e nella posta: con «Inserisci» va subito nel modulo."),
      h("ul", { class: "fill-list todo" }, mancanti.map(voce)), salva) : null,
    compilati.length ? h("section", null, h("h3", null, "Compilati"),
      h("ul", { class: "fill-list" }, compilati.map((c) =>
        h("li", null, h("strong", null, c.campo), h("span", null, String(c.valore)),
          c.pagina ? h("em", null, `pag. ${c.pagina}`) : null)))) : null);
  panel.hidden = false;
}

/** I dati inseriti a mano, in cassaforte per la prossima compilazione (solo dopo il «Sì» dell'utente). */
async function ricorda(dati) {
  const cfg = config();
  if (!cfg) throw new Error("Compilatore non collegato.");
  let res;
  try {
    res = await fetch(cfg.url + "/ricorda", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.chiave },
      body: JSON.stringify({ profilo: ultima ? ultima.profilo : null, nome: ultima ? ultima.file.name : "", dati }),
      ...addressSpace(cfg.url),
    });
  } catch {
    throw new Error("Compilatore non raggiungibile: dati non salvati.");
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.errore || `Il compilatore ha risposto con un errore (${res.status}).`);
  return out;
}
