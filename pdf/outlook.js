// Modalità Outlook (componente aggiuntivo): il lettore si apre nel riquadro
// laterale di Outlook ed elenca gli allegati del messaggio selezionato,
// compresi quelli contenuti nei messaggi allegati (es. postacert.eml delle PEC).
import { h, icon } from "./dom.js";
import { base64ToBytes, bytesToLatin1, latin1ToBytes } from "./p7m.js";

const OFFICE_JS = "https://appsforoffice.microsoft.com/lib/1/hosted/office.js";
const SUPPORTED = /\.(pdf|p7m|p7s|m7m|tsd|xml)$/i;
// File di servizio delle PEC e firme S/MIME: elencati, ma mai aperti in automatico.
const SERVICE_FILES = /^(daticert\.xml|smime\.p7s|smime\.p7m)$/i;

let app;
let autoOpenedFor = null;

/**
 * Avvia l'integrazione. Restituisce false se la pagina non è dentro Outlook.
 * @param {{ els: object, openBytes: Function, showHome: Function, pickFile: Function,
 *           toast: Function, busy: Function, idle: Function, currentFile: Function }} api
 */
export async function start(api) {
  app = api;
  try {
    await loadScript(OFFICE_JS);
    const info = await Office.onReady();
    if (info.host !== Office.HostType.Outlook) return false;
  } catch {
    return false;
  }
  document.body.classList.add("outlook");
  const { els } = app;
  els.btnOpen.title = "Allegati del messaggio";
  els.btnOpen.querySelector("use").setAttribute("href", "#i-clip");
  els.btnOpen.querySelector(".btn-label").textContent = "Allegati";
  els.btnWindow.hidden = false;
  els.btnWindow.addEventListener("click", openInWindow);

  if (!Office.context.requirements.isSetSupported("Mailbox", "1.8")) {
    renderList([], "Questa versione di Outlook non permette ai componenti aggiuntivi di leggere gli allegati: aggiornala o usa Outlook sul web.");
    return true;
  }
  // Con il riquadro aggiunto, cambiando messaggio si aggiorna l'elenco.
  Office.context.mailbox.addHandlerAsync(Office.EventType.ItemChanged, () => refresh());
  refresh();
  return true;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("office.js non disponibile"));
    document.head.append(s);
  });
}

/* --------------------------------------------------- Elenco allegati */

function sizeLabel(bytes) {
  if (!bytes) return "";
  return bytes > 1048576 ? `${(bytes / 1048576).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function kindLabel(name, isMessage) {
  if (isMessage) return "Messaggio allegato";
  if (/^daticert\.xml$/i.test(name)) return "Ricevuta PEC";
  if (/\.(p7m|m7m|tsd)$/i.test(name)) return "Documento firmato";
  if (/\.pdf$/i.test(name)) return "PDF";
  if (/\.xml$/i.test(name)) return "XML";
  return "";
}

function entry({ name, size, isMessage = false, open }) {
  const meta = [kindLabel(name, isMessage), sizeLabel(size)].filter(Boolean).join(" · ");
  const li = h("li", null);
  li.append(h("button", { class: "att-item" + (SUPPORTED.test(name) || isMessage ? " supported" : ""), type: "button", onclick: () => open(li) },
    icon(isMessage ? "mail" : "file"),
    h("span", { class: "att-text" }, h("strong", null, name), meta && h("span", null, meta))));
  return li;
}

function renderList(entries, note) {
  app.els.dropCard.replaceChildren(...[
    h("div", { class: "drop-icon" }, icon("clip")),
    h("h1", null, "Allegati del messaggio"),
    note && h("p", { class: "drop-hint" }, note),
    entries.length > 0 && h("ul", { class: "att-list" }, entries),
    h("p", { class: "formats" },
      h("button", { class: "btn subtle", type: "button", onclick: app.pickFile }, icon("open"), h("span", null, "Apri un file dal computer"))),
  ].filter(Boolean));
}

async function refresh() {
  const item = Office.context.mailbox.item;
  await app.showHome();
  if (!item) {
    renderList([], "Seleziona un messaggio per vederne gli allegati.");
    return;
  }
  const attachments = (item.attachments || []).filter((a) => !a.isInline || SUPPORTED.test(a.name));
  const entries = attachments.map((a) => a.attachmentType === "item"
    ? entry({ name: a.name, size: a.size, isMessage: true, open: (li) => toggleMessage(item, a, li) })
    : entry({ name: a.name, size: a.size, open: () => openAttachment(item, a) }));
  renderList(entries, attachments.length ? null : "Questo messaggio non ha allegati.");

  // Apertura automatica: l'unico documento apribile, oppure il contenuto di una PEC.
  if (autoOpenedFor === item.itemId) return;
  autoOpenedFor = item.itemId;
  const documents = attachments.filter((a) => a.attachmentType === "file" && SUPPORTED.test(a.name) && !SERVICE_FILES.test(a.name));
  const pec = attachments.find((a) => a.attachmentType === "item" && /^postacert(\.eml)?$/i.test(a.name));
  if (documents.length === 1) openAttachment(item, documents[0]);
  else if (!documents.length && pec) {
    const li = entries[attachments.indexOf(pec)];
    const inner = await toggleMessage(item, pec, li);
    const docs = (inner || []).filter((x) => SUPPORTED.test(x.name) && !SERVICE_FILES.test(x.name));
    if (docs.length === 1) app.openBytes(docs[0].bytes, docs[0].name);
  }
}

function attachmentContent(item, id) {
  return new Promise((resolve, reject) => {
    item.getAttachmentContentAsync(id, (r) => {
      if (r.status === Office.AsyncResultStatus.Succeeded) resolve(r.value);
      else reject(new Error((r.error && r.error.message) || "allegato non disponibile"));
    });
  });
}

async function openAttachment(item, a) {
  app.busy("Lettura dell'allegato…", { delay: 200 });
  try {
    const c = await attachmentContent(item, a.id);
    const F = Office.MailboxEnums.AttachmentContentFormat;
    if (c.format === F.Base64) {
      await app.openBytes(base64ToBytes(c.content), a.name);
    } else if (c.format === F.Url) {
      app.idle();
      window.open(c.content, "_blank", "noopener");
    } else {
      // Inviti di calendario o altri contenuti testuali.
      await app.openBytes(new TextEncoder().encode(c.content), a.name);
    }
  } catch (e) {
    app.idle();
    app.toast(`Impossibile leggere l'allegato: ${e.message || e}`, "error");
  }
}

// Messaggio allegato: mostra (o nasconde) i suoi allegati. Restituisce gli allegati trovati.
async function toggleMessage(item, a, li) {
  const existing = li.querySelector("ul");
  if (existing) {
    existing.hidden = !existing.hidden;
    return null;
  }
  app.busy("Lettura del messaggio allegato…", { delay: 200 });
  try {
    const c = await attachmentContent(item, a.id);
    const raw = c.format === Office.MailboxEnums.AttachmentContentFormat.Base64 ? bytesToLatin1(base64ToBytes(c.content)) : emlText(c.content);
    const inner = parseEml(raw);
    li.append(h("ul", { class: "att-list nested" }, inner.length
      ? inner.map((x) => entry({ name: x.name, size: x.bytes.length, open: () => app.openBytes(x.bytes, x.name) }))
      : h("li", { class: "att-empty" }, "Il messaggio non contiene allegati.")));
    return inner;
  } catch (e) {
    app.toast(`Impossibile leggere il messaggio allegato: ${e.message || e}`, "error");
    return null;
  } finally {
    app.idle();
  }
}

/* ------------------------------------------- Messaggi .eml (MIME) */

// Alcune versioni di Outlook restituiscono l'EML codificato in Base64.
function emlText(content) {
  const head = content.slice(0, 300);
  if (!/^[\w-]+\s*:/m.test(head) && /^[A-Za-z0-9+/=\s]+$/.test(head)) {
    try {
      return bytesToLatin1(base64ToBytes(content));
    } catch {
      // Non era Base64.
    }
  }
  return content;
}

function splitHeaders(part) {
  const sep = /\r?\n\r?\n/.exec(part);
  const head = sep ? part.slice(0, sep.index) : part;
  const body = sep ? part.slice(sep.index + sep[0].length) : "";
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, body };
}

// Testo arrivato come byte grezzi (es. UTF-8 letto come Latin-1): lo si ridecodifica.
function fixRaw(s) {
  if (!/[\x80-\xff]/.test(s) || /[^\x00-\xff]/.test(s)) return s;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(latin1ToBytes(s));
  } catch {
    return s;
  }
}

function decodeWithCharset(bytes, charset) {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// =?utf-8?B?...?= e =?iso-8859-1?Q?...?=
function decodeWords(s) {
  return fixRaw(s).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (m, charset, enc, text) => {
    const bytes = enc.toUpperCase() === "B"
      ? base64ToBytes(text)
      : latin1ToBytes(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (x, hex) => String.fromCharCode(parseInt(hex, 16))));
    return decodeWithCharset(bytes, charset);
  });
}

// RFC 2231: charset'lingua'testo%20codificato
function decode2231(s) {
  const m = /^([^']*)'[^']*'(.*)$/.exec(s);
  const text = m ? m[2] : s;
  const bytes = latin1ToBytes(text.replace(/%([0-9A-Fa-f]{2})/g, (x, hex) => String.fromCharCode(parseInt(hex, 16))));
  return decodeWithCharset(bytes, m ? m[1] : "utf-8");
}

function param(value, name) {
  if (!value) return "";
  const pieces = [];
  const continued = new RegExp(`;\\s*${name}\\*(\\d+)(\\*?)\\s*=\\s*("([^"]*)"|[^;]*)`, "gi");
  let m;
  while ((m = continued.exec(value))) pieces[+m[1]] = { encoded: !!m[2], text: m[4] !== undefined ? m[4] : m[3].trim() };
  if (pieces.length) {
    const joined = pieces.map((p) => (p ? p.text : "")).join("");
    return pieces[0] && pieces[0].encoded ? decode2231(joined) : decodeWords(joined);
  }
  m = new RegExp(`;\\s*${name}\\*\\s*=\\s*("([^"]*)"|[^;]*)`, "i").exec(value);
  if (m) return decode2231(m[2] !== undefined ? m[2] : m[1].trim());
  m = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*("([^"]*)"|[^;]*)`, "i").exec(value);
  if (m) return decodeWords(m[2] !== undefined ? m[2] : m[1].trim());
  return "";
}

function quotedPrintable(s) {
  s = s.replace(/=\r?\n/g, "");
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
      out.push(parseInt(s.substr(i + 1, 2), 16));
      i += 2;
    } else {
      out.push(s.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function decodeBody(body, encoding) {
  const enc = (encoding || "").trim().toLowerCase();
  if (enc === "base64") return base64ToBytes(body);
  if (enc === "quoted-printable") return quotedPrintable(body);
  const text = body.replace(/\r?\n$/, "");
  return /[^\x00-\xff]/.test(text) ? new TextEncoder().encode(text) : latin1ToBytes(text);
}

/** Allegati contenuti in un messaggio in formato EML (anche annidati). */
export function parseEml(raw, out = [], depth = 0) {
  if (depth > 8) return out;
  const { headers, body } = splitHeaders(raw);
  const contentType = headers["content-type"] || "text/plain";
  const type = contentType.split(";")[0].trim().toLowerCase();
  const disposition = headers["content-disposition"] || "";
  if (type.startsWith("multipart/")) {
    const boundary = param(contentType, "boundary");
    if (!boundary) return out;
    const segments = body.split("--" + boundary);
    for (let i = 1; i < segments.length; i++) {
      if (segments[i].startsWith("--")) break;
      parseEml(segments[i].replace(/^\r?\n/, ""), out, depth + 1);
    }
    return out;
  }
  const bytes = decodeBody(body, headers["content-transfer-encoding"]);
  if (type === "message/rfc822") return parseEml(bytesToLatin1(bytes), out, depth + 1);
  const name = param(disposition, "filename") || param(contentType, "name");
  const attachment = /^\s*attachment/i.test(disposition);
  if (!name && !attachment) return out; // corpo del messaggio o immagini senza nome
  if (/^application\/(x-)?pkcs7-signature$/.test(type) && /^smime\.p7s$/i.test(name)) return out; // firma S/MIME dell'email
  out.push({ name: name || "allegato", bytes, type });
  return out;
}

/* ------------------------------------------ Apertura in una finestra */

// Il riquadro di Outlook è stretto: il documento si può aprire nel lettore a
// pagina intera, passando il file alla nuova finestra con postMessage.
function openInWindow() {
  const file = app.currentFile();
  const url = new URL("./?ricevi=1", location.href).href;
  if (!file) {
    window.open(url.replace("?ricevi=1", ""), "_blank");
    return;
  }
  const win = window.open(url, "_blank");
  if (!win) {
    app.toast("Il browser ha bloccato la nuova finestra.", "error");
    return;
  }
  const timer = setTimeout(() => {
    window.removeEventListener("message", onMessage);
    app.toast("Se la nuova finestra non mostra il documento, usa «Salva» e aprilo da lì.");
  }, 15000);
  function onMessage(e) {
    if (e.source !== win || e.origin !== location.origin || !e.data || e.data.type !== "lettore-pronto") return;
    window.removeEventListener("message", onMessage);
    clearTimeout(timer);
    const bytes = file.bytes.slice();
    win.postMessage({ type: "lettore-file", name: file.name, bytes }, location.origin, [bytes.buffer]);
  }
  window.addEventListener("message", onMessage);
}
