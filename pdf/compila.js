// «Compila»: manda il modulo PDF a un compilatore privato, che lo restituisce
// compilato. Il sito non contiene né l'indirizzo né la chiave del compilatore:
// si collegano una volta per dispositivo aprendo un link del compilatore stesso
// (…/pdf/#compilatore=<indirizzo>&chiave=<chiave>), e restano solo in questo browser.

import { h, icon } from "./dom.js";
import * as cassaforte from "./cassaforte.js";

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
    // «solo=collega»: il link di un collega, che compila per la Vinicola o per sé, con la SUA scheda
    const collega = p.get("solo") === "collega" || p.get("solo") === "azienda";
    localStorage.setItem(STORE, JSON.stringify({ url: u.href.replace(/\/$/, ""), chiave, collega }));
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
              h("span", null, h("strong", null, t), h("small", { "data-testo": d }, d)))),
          h("button", { class: "btn subtle fill-miei", type: "button", hidden: true,
            onclick: () => apriMieiDati() }, "I miei dati")),
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
  // Colleghi: «Azienda» (con sé come referente) o «Personale» (la propria scheda); niente «firmo io».
  const collega = !!(config() || {}).collega;
  for (const r of dialog.querySelectorAll("input[name=fillWho]")) {
    r.closest("label").hidden = collega && r.value === "azienda_io";
    const d = r.closest("label").querySelector("small");
    d.textContent = collega && r.value === "azienda" ? "la Vinicola, con te come referente"
      : collega && r.value === "personale" ? "i tuoi dati privati" : d.dataset.testo;
  }
  dialog.querySelector(".fill-miei").hidden = false;
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
  // Prima i dati dalla cassaforte aziendale (per i colleghi è obbligatoria; Alessandro può ancora usare la VM).
  let schede = null;
  try {
    schede = await preparaSchede(ui);
  } catch (e) {
    if (e.message !== "annullato") ui.toast(e.message || String(e), "error");
    return null;
  }
  const scelta = await askInstructions(file.name);
  if (scelta === null) return null;
  const { profilo, chi } = scelta;
  // Per l'azienda chi compila è il referente o la persona di contatto da proporre.
  const notes = [chi && profilo !== "personale"
    ? `Chi compila il modulo: ${chi}. Nei campi «referente», «persona di contatto», «compilato da» o simili proponi questo nome.`
    : "", scelta.notes].filter(Boolean).join("\n");
  ultima = { file, notes, profilo, schede };
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
        body: JSON.stringify({ nome: file.name, pdf: toBase64(file.bytes), istruzioni: notes, profilo,
          schede: ultima && ultima.schede ? ultima.schede : undefined }),
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
// compito: "riassumi" (Markdown), "traduci" (Markdown, tutto il documento), "punti" (le frasi da sottolineare)
export async function riassumi(name, pages, ui, compito = "riassumi") {
  const cfg = config();
  if (!cfg) throw new Error("Per usare l'AI collega prima il compilatore.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  ui.busy({ traduci: "Traduco il documento… (può volerci un paio di minuti)",
    punti: "Cerco i punti importanti… (di solito meno di un minuto)" }[compito] || "Riassumo il documento… (di solito meno di un minuto)",
  { onCancel: () => ctrl.abort() });
  try {
    let res;
    try {
      res = await fetch(cfg.url + "/riassumi", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.chiave },
        body: JSON.stringify({ nome: name, pagine: pages, compito }),
        signal: ctrl.signal,
        ...addressSpace(cfg.url),
      });
    } catch (e) {
      if (e.name === "AbortError") throw new Error("Annullato.");
      throw new Error("Compilatore non raggiungibile (serve la rete privata o quella dell'ufficio).");
    }
    const out = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error("Il compilatore non riconosce questo dispositivo: ricollegalo.");
    if (!res.ok || !(out.riassunto || out.punti)) throw new Error(out.errore || `Il compilatore ha risposto con un errore (${res.status}).`);
    return compito === "punti" ? out.punti : out.riassunto;
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
      ? `Traduzione dell'AI di «${name}»: per un uso ufficiale serve una traduzione verificata.`
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

/** I punti sottolineati dall'AI, con il perché; cliccando si va alla pagina. trovati = quanti ritrovati sulla pagina. */
export function renderPunti(panel, body, punti, name, vai) {
  const title = panel.querySelector("h2");
  if (title) title.textContent = "Punti importanti";
  const trovati = punti.filter((p) => p.trovato).length;
  body.replaceChildren(
    h("p", { class: "fill-hint" }, `Scelti dall'AI in «${name}» e sottolineati in rosso nel documento` +
      (trovati < punti.length ? ` (${punti.length - trovati} non ritrovati sulla pagina: sono qui sotto, senza sottolineatura).` : ".")),
    h("ul", { class: "fill-list" }, punti.map((p) => h("li", { class: "fill-vai", onclick: () => vai(p.pagina) },
      h("strong", null, p.perche || "Da notare"), h("span", null, `«${p.frase}»`),
      h("em", { class: "fill-fonte" }, `pag. ${p.pagina}${p.trovato ? "" : " · non ritrovato"}`)))),
    h("p", { class: "fill-hint" }, "Le sottolineature si tolgono con «Annulla» e restano nel PDF salvato."));
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
            const dati = inseriti.splice(0);
            const r = cassaforte.aperta()
              ? await aggiungiAiMieiDati(dati, ultima ? ultima.file.name : "un modulo")
              : await ricorda(dati);
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
            r.brano ? h("blockquote", { class: "fill-brano" }, `«${r.brano}»`) : null,
            h("button", { class: "btn primary", type: "button", onclick: () => metti(m, r.valore, stato) }, "Inserisci"));
        } catch (err) {
          stato.replaceChildren(h("span", null, err.message || String(err)));
          b.disabled = false;
        }
      } }, "Cercalo"));
    return h("li", null, h("strong", null, m.campo), m.motivo ? h("span", null, m.motivo) : null, bottoni, scrivi, stato);
  };
  // I dati delicati compilati dall'AI si spuntano come verificati: salvando prima, C.A.R.T.A. chiede conferma
  // (suggerimento delle altre AI, 30/10/2026). Stato per il modulo aperto, letto da app.js con daVerificare().
  const delicati = compilati.filter(eDelicato);
  daVerificareOra = new Set(delicati.map((c) => c.pdf_campo || c.campo));
  const titolo = panel.querySelector("h2");
  if (titolo) titolo.textContent = "Compilazione da verificare";
  const voceCompilata = (c) => {
    const chiave = c.pdf_campo || c.campo;
    const verifica = eDelicato(c) ? h("button", { class: "btn fill-verifica", type: "button", onclick: (e) => {
      e.stopPropagation();
      daVerificareOra.delete(chiave);
      e.currentTarget.replaceWith(h("span", { class: "fill-ok" }, "✓ verificato"));
      aggiornaConteggi();
    } }, "Verificato") : null;
    return h("li", { class: c.pdf_campo ? "fill-vai" : null, title: c.pdf_campo ? "Mostra nel modulo" : null,
      onclick: () => c.pdf_campo && azioni.mostra && azioni.mostra(c.pdf_campo) },
      h("strong", null, c.campo), h("span", { class: "fill-valore" }, String(c.valore)),
      h("em", { class: "fill-fonte" }, FONTI[c.fonte] || "dedotto dall'AI"), verifica);
  };
  const conteggi = h("p", { class: "fill-summary" });
  // replaceChildren non salta i null come fa h(): senza il filtro nel pannello compariva la parola «null» (31/10/2026)
  const aggiornaConteggi = () => conteggi.replaceChildren(...[
    `${compilati.length} compilati · ${mancanti.length} da completare · ${daVerificareOra.size} da verificare`,
    report.metodo === "posizioni" ? h("small", null, " (modulo senza campi: ho aggiunto i campi sopra la pagina)") : null].filter(Boolean));
  aggiornaConteggi();
  body.replaceChildren(...[
    conteggi,
    report.dalla_memoria ? h("p", { class: "fill-hint" }, "⚡ Compilato subito dalla memoria: questo modulo, con questi dati, era già stato compilato negli ultimi 30 giorni.") : null,
    // dati delicati della Vinicola cambiati nella cassaforte aziendale (vedi sorveglianza.py del compilatore)
    (report.avvisi || []).length ? h("div", { class: "fill-avviso", role: "alert" },
      h("strong", null, "⚠️ Attenzione"), ...report.avvisi.map((a) => h("p", null, a))) : null,
    h("p", { class: "fill-hint" }, "In blu, a macchina da scrivere, quello che ho scritto io: puoi correggerlo cliccandoci. Gli spazi vuoti e i quadratini si compilano cliccandoci sopra."),
    mancanti.length ? h("section", null, h("h3", null, "Da completare"),
      h("p", { class: "fill-hint" }, "Scrivilo tu o lo cerco io nei Files Comuni, su OneDrive e nella posta: con «Inserisci» va subito nel modulo."),
      h("ul", { class: "fill-list todo" }, mancanti.map(voce)), salva) : null,
    delicati.length ? h("section", null, h("h3", null, "Da verificare"),
      h("p", { class: "fill-hint" }, "Dati che contano (IBAN, codici, PEC, dichiarazioni): controllali sul modulo e spunta «Verificato»."),
      h("ul", { class: "fill-list" }, delicati.map(voceCompilata))) : null,
    compilati.length > delicati.length ? h("section", null, h("h3", null, "Compilati"),
      h("p", { class: "fill-hint" }, "Clicca un dato per vederlo nel modulo."),
      h("ul", { class: "fill-list" }, compilati.filter((c) => !eDelicato(c)).map(voceCompilata))) : null].filter(Boolean));
  panel.hidden = false;
}

// Da dove viene ogni dato compilato (lo dice il compilatore)
const FONTI = { azienda: "dalla cassaforte: Vinicola", persona: "dalla cassaforte: i tuoi dati", istruzioni: "dalle tue istruzioni", oggi: "data e luogo di oggi" };
const eDelicato = (c) => /iban|partita iva|p\.\s?iva|codice fiscale|pec|sdi|codice destinatario|dichiar|consapevole|liquidazione|durc|regola/i.test(c.campo)
  || c.valore === "spuntata";
let daVerificareOra = new Set();

/** Quanti dati delicati del modulo compilato aperto non sono ancora stati spuntati come verificati. */
export const daVerificare = () => daVerificareOra.size;
export function dimenticaVerifiche() {
  daVerificareOra = new Set();
}

/* ------------------------------- Cassaforte aziendale e «I miei dati» */

// Le voci della scheda personale: una riga «- **Voce**: valore» ciascuna; le altre righe (anche i dati aggiunti
// dai moduli, o una scheda scritta a mano) restano in «Altro».
const VOCI = ["Nome e cognome", "Ruolo in azienda", "E-mail", "Telefono", "Cellulare", "Codice fiscale",
  "Data di nascita", "Luogo di nascita", "Residenza", "Domicilio (se diverso)"];

const campo = (etichetta, attr) => h("label", { class: "cf-campo" }, h("span", null, etichetta), h("input", attr));

let accessoDlg = null;

/**
 * Entra nella cassaforte aziendale (e-mail, password, codice a 6 cifre se serve).
 * «puoSaltare»: Alessandro, finché non ha copiato i suoi dati, può usare ancora quelli della VM.
 * Ritorna true (dentro), "salta" o false (annullato).
 */
async function accediCassaforte(puoSaltare) {
  if (cassaforte.aperta()) return true;
  if (!accessoDlg) {
    accessoDlg = h("dialog", { class: "modal cf-dialog", "aria-labelledby": "cfTitle" },
      h("form", { method: "dialog" },
        h("h2", { id: "cfTitle" }, icon("lock"), " Cassaforte aziendale"),
        h("p", { class: "fill-hint" }, "I dati per i moduli stanno nella cassaforte aziendale (cassaforte.it.fo). "
          + "Entra con le tue credenziali: la password non esce da questo dispositivo."),
        campo("E-mail", { type: "email", name: "email", autocomplete: "username", required: true }),
        campo("Password della cassaforte", { type: "password", name: "password", autocomplete: "current-password", required: true }),
        h("div", { class: "cf-codice", hidden: true },
          campo("Codice a 6 cifre dell'app di autenticazione", { type: "text", name: "codice", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 8 })),
        h("p", { class: "cf-errore", role: "alert" }),
        h("div", { class: "modal-actions" },
          h("button", { class: "btn", type: "submit", value: "cancel", formnovalidate: true }, "Annulla"),
          h("button", { class: "btn cf-salta", type: "submit", value: "salta", formnovalidate: true }, "Usa quelli della VM"),
          h("button", { class: "btn primary", type: "submit", value: "ok" }, "Entra"))));
    document.body.append(accessoDlg);
  }
  const f = accessoDlg.querySelector("form");
  const errore = accessoDlg.querySelector(".cf-errore");
  const codiceBox = accessoDlg.querySelector(".cf-codice");
  f.email.value = cassaforte.emailRicordata();
  f.password.value = "";
  f.codice.value = "";
  codiceBox.hidden = true;
  errore.textContent = "";
  accessoDlg.querySelector(".cf-salta").hidden = !puoSaltare;
  return new Promise((resolve) => {
    const chiudi = (v) => {
      f.removeEventListener("submit", invio);
      f.password.value = "";
      if (accessoDlg.open) accessoDlg.close();
      resolve(v);
    };
    const invio = async (e) => {
      const azione = e.submitter ? e.submitter.value : "ok";
      if (azione !== "ok") return chiudi(azione === "salta" ? "salta" : false);
      e.preventDefault();
      const bottone = e.submitter;
      bottone.disabled = true;
      errore.textContent = "Apro la cassaforte… (qualche secondo)";
      try {
        const esito = await cassaforte.entra(f.email.value, f.password.value, codiceBox.hidden ? "" : f.codice.value);
        if (esito === "serve-codice") {
          codiceBox.hidden = false;
          errore.textContent = "Il tuo account chiede anche il codice dell'app di autenticazione.";
          f.codice.focus();
        } else {
          chiudi(true);
        }
      } catch (err) {
        errore.textContent = err.message || String(err);
      } finally {
        bottone.disabled = false;
      }
    };
    f.addEventListener("submit", invio);
    accessoDlg.showModal();
    (f.email.value ? f.password : f.email).focus();
  });
}

let raccoltaDlg = null;

// La raccolta col nome di chi compila; se non si capisce quale è, la sceglie lui una volta.
async function raccoltaPersonale() {
  const trovata = cassaforte.raccoltaPersonale();
  if (trovata) return trovata;
  const scelte = cassaforte.raccolteScrivibili();
  if (!scelte.length) throw new Error("Nella cassaforte aziendale non hai una raccolta dove scrivere: chiedi ad Alessandro.");
  if (!raccoltaDlg) {
    raccoltaDlg = h("dialog", { class: "modal cf-dialog" },
      h("form", { method: "dialog" },
        h("h2", null, "Qual è la tua raccolta?"),
        h("p", { class: "fill-hint" }, "Nella cassaforte aziendale scegli la raccolta col tuo nome: lì metto i tuoi dati per i moduli."),
        h("select", { name: "raccolta", class: "cf-select" }),
        h("div", { class: "modal-actions" },
          h("button", { class: "btn", type: "submit", value: "cancel" }, "Annulla"),
          h("button", { class: "btn primary", type: "submit", value: "ok" }, "Usa questa"))));
    document.body.append(raccoltaDlg);
  }
  const sel = raccoltaDlg.querySelector("select");
  sel.replaceChildren(...scelte.map((c) => h("option", { value: c.id }, c.nome)));
  raccoltaDlg.returnValue = "";
  const ok = await new Promise((resolve) => {
    raccoltaDlg.addEventListener("close", () => resolve(raccoltaDlg.returnValue === "ok"), { once: true });
    raccoltaDlg.showModal();
  });
  if (!ok) return null;
  cassaforte.scegliRaccolta(sel.value);
  return sel.value;
}

// Solo Alessandro: le schede della cassaforte della VM, per copiarle in quella aziendale.
async function esportaSchede() {
  const cfg = config();
  try {
    const res = await fetch(cfg.url + "/esporta-schede", { headers: { Authorization: "Bearer " + cfg.chiave }, ...addressSpace(cfg.url) });
    return res.ok ? await res.json() : { persona: "", azienda: "" };
  } catch {
    return { persona: "", azienda: "" };
  }
}

/**
 * Le schede per compilare, dalla cassaforte aziendale: {persona, azienda}. null = senza cassaforte (solo Alessandro,
 * con «Usa quelli della VM»). Se manca la sua voce, chiede prima i suoi dati; Alessandro (proprietario) la prima volta
 * copia anche quelli della Vinicola dalla VM.
 */
// Quale cassaforte usare per i dati dei moduli («Impostazioni», 31/10/2026): "aziendale" (cassaforte.it.fo) o "vm"
// (le schede del server, solo Alessandro). Senza argomento la legge, con l'argomento la salva.
const SCELTA_CF = "lettore-cassaforte-scelta";
export function sceltaCassaforte(nuova) {
  try {
    if (nuova) localStorage.setItem(SCELTA_CF, nuova);
    return localStorage.getItem(SCELTA_CF) || "aziendale";
  } catch {
    return nuova || "aziendale";
  }
}

async function preparaSchede(ui) {
  const cfg = config();
  // scelta «cassaforte del server» nelle impostazioni (non per i colleghi): niente cassaforte aziendale
  if (!cfg.collega && sceltaCassaforte() === "vm") return null;
  const entrato = await accediCassaforte(!cfg.collega);
  if (entrato === "salta") return null;
  if (!entrato) throw new Error("annullato");
  ui.busy("Apro i dati nella cassaforte aziendale…");
  let schede;
  try {
    const raccolta = await raccoltaPersonale();
    if (!raccolta) throw new Error("annullato");
    schede = await cassaforte.leggiSchede();
    const vm = !cfg.collega && (!schede.persona || !schede.azienda) ? await esportaSchede() : null;
    if (!schede.azienda && vm && vm.azienda && cassaforte.proprietario()) {
      ui.idle();
      if (confirm("Nella cassaforte aziendale non ci sono ancora i dati della Vinicola per i moduli.\n\n"
        + "Li copio da quelli della VM? Ti chiedo poi in quale raccolta (scegli quella che vedono tutti).")) {
        const dove = await sceltaRaccolta("Dove metto i dati della Vinicola? (la raccolta che vedono tutti)");
        if (dove) {
          ui.busy("Copio i dati della Vinicola nella cassaforte aziendale…");
          await cassaforte.scriviVoce(cassaforte.VOCE_AZIENDA, vm.azienda, dove);
          schede = await cassaforte.leggiSchede();
        }
      }
    }
    if (!schede.persona) {
      ui.idle();
      if (!(await apriMieiDati(vm ? vm.persona : ""))) throw new Error("annullato");
      schede = await cassaforte.leggiSchede();
    }
  } finally {
    ui.idle();
  }
  return { persona: schede.persona, azienda: schede.azienda };
}

// Una raccolta qualsiasi fra quelle dove si può scrivere (per i dati della Vinicola).
async function sceltaRaccolta(titolo) {
  const scelte = cassaforte.raccolteScrivibili();
  const elenco = scelte.map((c, i) => `${i + 1}. ${c.nome}`).join("\n");
  const n = parseInt(prompt(`${titolo}\n\n${elenco}\n\nScrivi il numero:`, "") || "", 10);
  return scelte[n - 1] ? scelte[n - 1].id : null;
}

let mieiDlg = null;

/** I dati di chi compila, nella sua raccolta della cassaforte aziendale; vero se salvati. */
export async function apriMieiDati(proposta = null) {
  if (!config()) return false;
  const entrato = await accediCassaforte(false);
  if (entrato !== true) return false;
  let raccolta;
  let testo = "";
  try {
    raccolta = await raccoltaPersonale();
    if (!raccolta) return false;
    testo = (await cassaforte.leggiSchede()).persona || proposta || "";
  } catch (e) {
    alert(e.message || String(e));
    return false;
  }
  if (!mieiDlg) {
    mieiDlg = h("dialog", { class: "modal miei-dialog", "aria-labelledby": "mieiTitle" },
      h("form", { method: "dialog" },
        h("h2", { id: "mieiTitle" }, "I miei dati"),
        h("p", { class: "fill-hint" }, "Servono per compilare i moduli dove ci sei tu (referente, dichiarante...). "
          + "Stanno nella tua raccolta della cassaforte aziendale, che vedono anche Alessandro e Giulia, e vanno all'AI "
          + "solo quando compili. Scrivi solo quello che vuoi: i campi vuoti restano vuoti nei moduli."),
        h("div", { class: "miei-campi" }, VOCI.map((v, i) =>
          h("label", null, h("span", null, v), h("input", { type: "text", "data-voce": v, autocomplete: "off", required: i === 0 })))),
        h("label", { class: "miei-altro" }, h("span", null, "Altro (un dato per riga)"), h("textarea", { rows: 6 })),
        h("div", { class: "modal-actions" },
          h("button", { class: "btn subtle cf-esci", type: "submit", value: "esci", formnovalidate: true }, "Esci dalla cassaforte"),
          h("button", { class: "btn", type: "submit", value: "cancel", formnovalidate: true }, "Annulla"),
          h("button", { class: "btn primary", type: "submit", value: "ok" }, "Salva"))));
    document.body.append(mieiDlg);
  }
  const valori = {};
  const altro = [];
  for (const riga of String(testo).split("\n")) {
    const m = /^- \*\*(.+?)\*\*: (.*)$/.exec(riga.trim());
    if (m && VOCI.includes(m[1])) valori[m[1]] = m[2];
    else if (riga.trim() && !/^# Dati di /.test(riga)) altro.push(riga.replace(/^- /, ""));
  }
  for (const i of mieiDlg.querySelectorAll("input[data-voce]")) i.value = valori[i.dataset.voce] || "";
  if (!valori["Nome e cognome"]) mieiDlg.querySelector("input[data-voce]").value = cassaforte.nomeUtente();
  mieiDlg.querySelector("textarea").value = altro.join("\n");
  mieiDlg.returnValue = "";
  const scelta = await new Promise((resolve) => {
    mieiDlg.addEventListener("close", () => resolve(mieiDlg.returnValue), { once: true });
    mieiDlg.showModal();
  });
  if (scelta === "esci") {
    cassaforte.esci();
    return false;
  }
  if (scelta !== "ok") return false;
  const nome = mieiDlg.querySelector("input[data-voce]").value.trim();
  const righe = [...mieiDlg.querySelectorAll("input[data-voce]")]
    .filter((i) => i.value.trim()).map((i) => `- **${i.dataset.voce}**: ${i.value.trim()}`);
  const extra = mieiDlg.querySelector("textarea").value.split("\n").map((r) => r.trimEnd()).filter((r) => r.trim())
    .map((r) => (/^(#|- |\s)/.test(r) ? r : `- ${r}`));
  const nuovo = [`# Dati di ${nome || "chi compila"} per i moduli`, ...righe, ...extra].join("\n");
  try {
    await cassaforte.scriviVoce(cassaforte.VOCE_PERSONA, nuovo, raccolta);
  } catch (e) {
    alert(e.message || String(e));
    return false;
  }
  try {
    if (nome && !localStorage.getItem(CHI)) localStorage.setItem(CHI, nome);
  } catch { /* niente */ }
  return true;
}

// «Sì, salvali»: i dati inseriti a mano vanno in fondo alla voce personale della cassaforte aziendale.
async function aggiungiAiMieiDati(dati, modulo) {
  const raccolta = await raccoltaPersonale();
  if (!raccolta) throw new Error("Dati non salvati: manca la tua raccolta.");
  const ora = (await cassaforte.leggiSchede()).persona || "";
  const oggi = new Date().toLocaleDateString("it-IT");
  const righe = dati.map((d) => `- **${d.campo}**: ${d.valore} (da «${modulo}», ${oggi})`);
  await cassaforte.scriviVoce(cassaforte.VOCE_PERSONA, [ora.trimEnd(), ...righe].filter(Boolean).join("\n"), raccolta);
  return { aggiunti: dati.length };
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
