import { unwrap, sniff, innerFileName } from "./p7m.js";
import { h, icon } from "./dom.js";
import * as compilatore from "./compila.js";

const SHARED_CACHE = "lettore-pdf-condivisi";
const BUSY_DELAY = 200; // le aperture rapide non mostrano l'indicatore di attesa

const $ = (id) => document.getElementById(id);
const els = {
  appStyle: $("appStyle"),
  btnOpen: $("btnOpen"),
  btnOpenBig: $("btnOpenBig"),
  btnWindow: $("btnWindow"),
  dropCard: $("dropCard"),
  btnBack: $("btnBack"),
  versione: $("versione"),
  btnInstall: $("btnInstall"),
  fileInput: $("fileInput"),
  docTitle: $("docTitle"),
  sigChip: $("sigChip"),
  viewControls: $("viewControls"),
  btnPrev: $("btnPrev"),
  btnNext: $("btnNext"),
  pageNumber: $("pageNumber"),
  pageCount: $("pageCount"),
  btnZoomOut: $("btnZoomOut"),
  btnZoomIn: $("btnZoomIn"),
  zoomSelect: $("zoomSelect"),
  zoomCustom: $("zoomCustom"),
  btnRotate: $("btnRotate"),
  btnRaddrizza: $("btnRaddrizza"),
  btnFind: $("btnFind"),
  btnBox: $("btnBox"),
  btnSelText: $("btnSelText"),
  btnNote: $("btnNote"),
  btnUpdate: $("btnUpdate"),
  btnUndo: $("btnUndo"),
  btnRedo: $("btnRedo"),
  signBarText: $("signBarText"),
  btnOcr: $("btnOcr"),
  ocrMenu: $("ocrMenu"),
  btnSign: $("btnSign"),
  btnFill: $("btnFill"),
  btnSum: $("btnSum"),
  sumPanel: $("sumPanel"),
  sumBody: $("sumBody"),
  sumClose: $("sumClose"),
  fillPanel: $("fillPanel"),
  fillBody: $("fillBody"),
  fillClose: $("fillClose"),
  signBar: $("signBar"),
  signDone: $("signDone"),
  btnDownload: $("btnDownload"),
  btnShare: $("btnShare"),
  shareMenu: $("shareMenu"),
  btnPrint: $("btnPrint"),
  findbar: $("findbar"),
  findInput: $("findInput"),
  findResult: $("findResult"),
  findPrev: $("findPrev"),
  findNext: $("findNext"),
  findClose: $("findClose"),
  welcome: $("welcome"),
  viewerContainer: $("viewerContainer"),
  viewer: $("viewer"),
  altView: $("altView"),
  sigPanel: $("sigPanel"),
  sigBody: $("sigBody"),
  sigClose: $("sigClose"),
  passwordDialog: $("passwordDialog"),
  passwordForm: $("passwordForm"),
  pwMessage: $("pwMessage"),
  pwInput: $("pwInput"),
  pwCancel: $("pwCancel"),
  busy: $("busy"),
  busyText: $("busyText"),
  busyProgress: $("busyProgress"),
  busyBar: $("busyBar"),
  busyCancel: $("busyCancel"),
  toast: $("toast"),
  printContainer: $("printContainer"),
  pageStyle: $("pageStyle"),
};

/**
 * Documento aperto:
 * { name, sourceName, sourceBytes, data, type, layers, parent, pdf, loadingTask, usedPassword, objectUrl, printable }
 */
let doc = null;
let openSeq = 0;
let printJob = null;

// Aperto da Outlook come componente aggiuntivo (vedi outlook/manifest.xml).
const OUTLOOK = new URLSearchParams(location.search).has("outlook");
let outlookActive = false;

/* ------------------------------------------- Caricamento di PDF.js */

let V = null; // modulo viewer.js, quando è pronto
let viewerLoading = null;

// Il worker di PDF.js (il file più grande) parte subito, in parallelo a PDF.js:
// altrimenti verrebbe scaricato solo dopo, in sequenza.
function startWorker() {
  try {
    return new Worker(new URL("lib/pdfjs/pdf.worker.min.mjs", import.meta.url), { type: "module", name: "lettore-pdf" });
  } catch {
    return null; // PDF.js ne crea uno da sé
  }
}

function loadStylesheet(href) {
  return new Promise((resolve, reject) => {
    const link = h("link", { rel: "stylesheet", href });
    link.onload = resolve;
    link.onerror = () => reject(new Error(`impossibile caricare ${href}`));
    // Prima del nostro foglio di stile, che deve poter sovrascrivere quello di PDF.js.
    document.head.insertBefore(link, els.appStyle);
  });
}

function loadViewer() {
  if (!viewerLoading) {
    const workerPort = startWorker();
    viewerLoading = Promise.all([import("./viewer.js"), loadStylesheet("lib/pdfjs/pdf_viewer.min.css")]).then(([mod]) => {
      mod.init(els, { hasPdf: () => !!(doc && doc.pdf), busy, idle, toast, h, workerPort,
        spiega: explain, canExplain: () => !!compilatore.config(),
        signEditing: () => {
          els.signBarText.textContent = "Trascina la firma dove serve e ridimensionala dagli angoli.";
          els.signBar.hidden = false;
        } });
      V = mod;
      return mod;
    });
    viewerLoading.catch(() => (viewerLoading = null)); // si riprova alla prossima apertura
  }
  return viewerLoading;
}

/* ----------------------------------------------------------- Utilità UI */

let toastTimer = 0;
function toast(message, kind = "info") {
  els.toast.textContent = message;
  els.toast.className = "toast" + (kind === "error" ? " error" : "");
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  // gli errori restano finché non si toccano: durante un'attesa lunga (compilazione) sparivano senza essere letti
  if (kind !== "error") toastTimer = setTimeout(() => (els.toast.hidden = true), 4000);
}
els.toast.addEventListener("click", () => (els.toast.hidden = true));

let busyTimer = 0;
function busy(text, { progress = null, onCancel = null, delay = 0 } = {}) {
  clearTimeout(busyTimer);
  const show = () => {
    els.busyText.textContent = text;
    els.busyProgress.hidden = progress == null;
    if (progress != null) els.busyBar.style.width = `${Math.round(progress * 100)}%`;
    els.busyCancel.hidden = !onCancel;
    els.busyCancel.onclick = onCancel;
    els.busy.hidden = false;
  };
  if (delay) busyTimer = setTimeout(show, delay);
  else show();
}
function idle() {
  clearTimeout(busyTimer);
  els.busy.hidden = true;
}

const dateTimeFmt = new Intl.DateTimeFormat("it-IT", {
  day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short",
});
const dateFmt = new Intl.DateTimeFormat("it-IT", { day: "2-digit", month: "2-digit", year: "numeric" });
const fmtDateTime = (d) => (d ? dateTimeFmt.format(d) : "—");
const fmtDate = (d) => (d ? dateFmt.format(d) : "—");

/* ----------------------------------------------------------- Apertura */

async function openFile(file) {
  if (!file) return;
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    toast("Impossibile leggere il file selezionato.", "error");
    return;
  }
  await openBytes(bytes, file.name);
}

/**
 * @param {Uint8Array} bytes contenuto del file
 * @param {string} name nome del file
 * @param {{ bytes: Uint8Array, name: string }} [parent] documento da cui proviene (allegato di una fattura)
 */
async function openBytes(bytes, name, parent = null, { sostituisci = false } = {}) {
  if (!sostituisci && !(await lasciaDocumento())) return;
  const seq = ++openSeq;
  busy("Apertura del documento…", { delay: BUSY_DELAY });
  try {
    // L'estrazione dalla busta è immediata; la verifica delle firme prosegue in parallelo.
    const { data, fileName, layers, verification } = unwrap(bytes);
    const type = sniff(data);
    if (type.kind === "pdf") loadViewer().catch(() => {});
    await closeDocument();
    if (seq !== openSeq) return;
    const current = (doc = {
      name: innerFileName(fileName || name, type.ext), sourceName: name, sourceBytes: bytes, data, type, layers, parent,
    });
    els.docTitle.textContent = current.name;
    els.docTitle.title = name;
    document.title = `${current.name} – C.A.R.T.A.`;
    renderSignatures(layers);
    verification.then(() => {
      if (doc === current) renderSignatures(layers);
    });
    if (type.kind === "pdf") await showPdf(seq);
    else await showOther(seq);
  } catch (e) {
    if (seq !== openSeq) return;
    toast(e && e.message ? e.message : "Impossibile aprire il file.", "error");
  } finally {
    if (seq === openSeq) idle();
    updateControls();
  }
}

// Torna alla schermata iniziale (in Outlook: l'elenco degli allegati).
async function showHome() {
  if (!(await lasciaDocumento())) return;
  ++openSeq;
  idle();
  await closeDocument();
  updateControls();
}

async function closeDocument() {
  const old = doc;
  doc = null;
  if (printJob) printJob.cancelled = true;
  clearPrint();
  closeShareMenu();
  if (V) V.closeFind();
  els.sigPanel.hidden = true;
  els.sigChip.hidden = true;
  els.fillPanel.hidden = true;
  els.sumPanel.hidden = true;
  els.signBar.hidden = true;
  // la modalità firma spegne la selezione del testo: se si cambia documento senza «Fatto» (succede sull'iPad)
  // restava spenta anche sul documento nuovo (30/10/2026)
  if (V) V.endImage();
  els.altView.replaceChildren();
  els.altView.hidden = true;
  if (!old) return;
  if (old.objectUrl) URL.revokeObjectURL(old.objectUrl);
  if (old.loadingTask) await V.close(old.loadingTask);
}

async function showPdf(seq) {
  let viewer;
  try {
    viewer = await loadViewer();
  } catch {
    if (seq !== openSeq) return;
    showMessage("file", "Visualizzatore non disponibile",
      "Non è stato possibile caricare il visualizzatore PDF: controlla la connessione e riprova. Intanto puoi salvare il documento.",
      [downloadButton()]);
    return;
  }
  if (seq !== openSeq) return;
  els.welcome.hidden = true;
  els.altView.hidden = true;
  els.viewerContainer.hidden = false;
  const task = viewer.load(doc.data, askPassword);
  doc.loadingTask = task;
  let pdf;
  try {
    pdf = await task.promise;
  } catch (e) {
    if (seq !== openSeq) return;
    els.viewerContainer.hidden = true;
    doc.loadingTask = null;
    task.destroy().catch(() => {});
    if (task.passwordCancelled) {
      showMessage("lock", "Documento protetto da password", "Per visualizzarlo serve la password con cui è stato protetto.", [
        h("button", { class: "btn primary", type: "button", onclick: retryPdf }, "Inserisci la password"),
      ]);
    } else {
      showMessage("file", "Il PDF non può essere visualizzato",
        `Il file sembra danneggiato o non è un PDF valido (${(e && e.message) || e}). Puoi comunque provare a salvarlo e aprirlo con un altro programma.`,
        [downloadButton()]);
    }
    return;
  }
  if (seq !== openSeq) {
    task.destroy();
    return;
  }
  doc.pdf = pdf;
  doc.usedPassword = !!task.usedPassword;
  const questo = doc;
  pdf.annotationStorage.onSetModified = () => {
    questo.modificato = true;
  };
  viewer.show(pdf, prossimiAngoli);
  prossimiAngoli = null;
  els.viewerContainer.focus({ preventScroll: true });
}

// Nuovo tentativo di apertura dello stesso PDF (ad esempio dopo aver annullato la password).
function retryPdf() {
  if (!doc) return;
  const seq = ++openSeq;
  busy("Apertura del documento…", { delay: BUSY_DELAY });
  showPdf(seq).finally(() => {
    if (seq === openSeq) idle();
    updateControls();
  });
}

function showMessage(iconName, title, text, actions = []) {
  els.welcome.hidden = true;
  els.viewerContainer.hidden = true;
  els.altView.hidden = false;
  els.altView.replaceChildren(
    h("div", { class: "message-card" },
      icon(iconName, "icon big"),
      h("h2", null, title),
      h("p", null, text),
      h("div", { class: "actions" }, actions))
  );
}

function downloadButton() {
  return h("button", { class: "btn primary", type: "button", onclick: downloadDocument },
    icon("download"), h("span", null, `Salva ${doc ? doc.name : "il file"}`));
}

/* -------------------------------------------- Contenuti diversi dal PDF */

function decodeText(bytes, kind) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  let encoding = "utf-8";
  if (kind === "xml") {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200));
    const m = /^﻿?\s*<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head);
    if (m) encoding = m[1];
  }
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

const LONG_TEXT = 4000;

// XML indentato, mostrato come testo (non riletto come XML): i valori restano
// leggibili, senza entità. I contenuti molto lunghi (allegati in Base64) sono abbreviati.
function formatXml(parsed, source) {
  const attrs = (el) => Array.from(el.attributes, (a) => ` ${a.name}="${a.value}"`).join("");
  const short = (s) => {
    const t = s.trim();
    if (t.length <= LONG_TEXT) return t;
    return `${t.slice(0, 120)}… [altri ${(t.length - 120).toLocaleString("it-IT")} caratteri omessi]`;
  };
  const lines = [];
  const decl = /^﻿?\s*(<\?xml[^>]*\?>)/.exec(source);
  if (decl) lines.push(decl[1]);
  const walk = (node, depth) => {
    const pad = "  ".repeat(depth);
    switch (node.nodeType) {
      case Node.ELEMENT_NODE: {
        const kids = Array.from(node.childNodes).filter((c) => !(c.nodeType === Node.TEXT_NODE && !c.nodeValue.trim()));
        const open = `<${node.nodeName}${attrs(node)}`;
        if (!kids.length) lines.push(`${pad}${open}/>`);
        else if (kids.length === 1 && kids[0].nodeType === Node.TEXT_NODE) {
          lines.push(`${pad}${open}>${short(kids[0].nodeValue)}</${node.nodeName}>`);
        } else {
          lines.push(`${pad}${open}>`);
          kids.forEach((k) => walk(k, depth + 1));
          lines.push(`${pad}</${node.nodeName}>`);
        }
        break;
      }
      case Node.TEXT_NODE:
        lines.push(pad + short(node.nodeValue));
        break;
      case Node.CDATA_SECTION_NODE:
        lines.push(`${pad}<![CDATA[${short(node.nodeValue)}]]>`);
        break;
      case Node.PROCESSING_INSTRUCTION_NODE:
        lines.push(`${pad}<?${node.target} ${node.data}?>`);
        break;
      case Node.COMMENT_NODE:
        lines.push(`${pad}<!--${node.nodeValue}-->`);
        break;
    }
  };
  parsed.childNodes.forEach((n) => walk(n, 0));
  return lines.join("\n");
}

const textSheet = (text, prose = false) =>
  h("div", { class: "sheet" }, h("pre", { class: "text-view" + (prose ? " prose" : "") }, text));

async function showOther(seq) {
  els.welcome.hidden = true;
  els.viewerContainer.hidden = true;
  els.altView.hidden = false;
  const current = doc;
  const { kind, mime } = current.type;
  if (kind === "text") {
    els.altView.replaceChildren(textSheet(decodeText(current.data, kind), true));
  } else if (kind === "xml") {
    const source = decodeText(current.data, kind);
    const parsed = new DOMParser().parseFromString(source, "application/xml");
    const root = parsed.getElementsByTagName("parsererror").length ? null : parsed.documentElement;
    if (!root) {
      els.altView.replaceChildren(textSheet(source));
    } else if (/^FatturaElettronica(Semplificata)?$/.test(root.localName)) {
      const { renderFattura } = await import("./fattura.js");
      if (seq !== openSeq) return;
      showInvoice(current, root, parsed, source, renderFattura);
    } else {
      els.altView.replaceChildren(textSheet(formatXml(parsed, source)));
    }
  } else if (kind === "image") {
    current.objectUrl = URL.createObjectURL(new Blob([current.data], { type: mime }));
    const img = h("img", { class: "image-view", alt: current.name });
    img.onerror = () => showBinary("Il browser non riesce a mostrare questa immagine.");
    img.src = current.objectUrl;
    els.altView.replaceChildren(img);
  } else {
    showBinary();
  }
}

// Fattura elettronica: vista leggibile, con l'XML originale a portata di clic.
function showInvoice(current, root, parsed, source, renderFattura) {
  const invoice = h("div", { class: "sheet" }, renderFattura(root, {
    open: (bytes, name) => openBytes(bytes, name, { bytes: current.sourceBytes, name: current.sourceName }),
    save: (bytes, name) => saveBytes(bytes, name),
  }));
  let xml = null;
  const tabs = h("div", { class: "view-tabs", role: "tablist" });
  const select = (which) => {
    if (which === "xml" && !xml) xml = textSheet(formatXml(parsed, source));
    for (const t of tabs.children) t.setAttribute("aria-selected", String(t.dataset.view === which));
    els.altView.replaceChildren(tabs, which === "xml" ? xml : invoice);
    els.altView.scrollTop = 0;
  };
  tabs.append(
    h("button", { class: "tab", type: "button", role: "tab", "data-view": "invoice", onclick: () => select("invoice") }, "Fattura"),
    h("button", { class: "tab", type: "button", role: "tab", "data-view": "xml", onclick: () => select("xml") }, "XML originale"));
  select("invoice");
}

function showBinary(reason) {
  doc.printable = false;
  showMessage("file", doc.layers.length ? `Documento estratto: ${doc.name}` : doc.name,
    reason ||
      `Questo tipo di file (.${doc.type.ext}) non si può visualizzare nel lettore. Salvalo e aprilo con l'applicazione adatta.`,
    [downloadButton()]);
  updateControls();
}

/* --------------------------------------------------------------- Firme */

const STATUS_ICON = { valid: "shield-ok", invalid: "shield-bad", unknown: "shield-unknown", pending: "shield-unknown" };
const STATUS_LABEL = { valid: "Integra", invalid: "Non valida", unknown: "Non verificata", pending: "In verifica…" };

const certProblem = (s) => s.certStatus === "expired" || s.certStatus === "notYetValid";

function overallStatus(layers) {
  const signers = layers.flatMap((l) => l.signers || []);
  const stamps = layers.flatMap((l) => [...(l.timestamps || []), ...(l.signers || []).flatMap((s) => s.timestamps)]);
  const all = [...signers, ...stamps];
  if (!all.length) return "unknown";
  if (all.some((x) => x.status === "invalid")) return "invalid";
  if (all.some((x) => x.status === "pending")) return "pending";
  if (signers.some(certProblem)) return "unknown";
  if (signers.length && signers.every((s) => s.status === "valid")) return "valid";
  if (!signers.length && stamps.every((s) => s.status === "valid")) return "valid";
  return "unknown";
}

function renderSignatures(layers) {
  els.sigBody.replaceChildren();
  if (!layers.length) {
    els.sigChip.hidden = true;
    return;
  }
  const signers = layers.flatMap((l) => l.signers || []);
  const status = overallStatus(layers);
  const label = els.sigChip.querySelector(".sig-chip-label");
  els.sigChip.querySelector("use").setAttribute("href", "#i-" + STATUS_ICON[status]);
  els.sigChip.className = "sig-chip " + status;
  const certIssue = signers.some(certProblem);
  let text;
  if (status === "invalid") text = "Firma non valida";
  else if (status === "pending") text = signers.length ? "Verifica della firma…" : "Verifica della marca…";
  else if (certIssue) text = signers.some((s) => s.certStatus === "expired") ? "Certificato scaduto" : "Certificato non valido";
  else if (!signers.length) text = status === "valid" ? "Marca temporale" : "Marca non verificata";
  else if (status === "unknown") text = "Firma non verificata";
  else text = signers.length === 1 ? `Firmato da ${niceName(signers[0].name)}` : `Firmato da ${signers.length} persone`;
  label.textContent = text;
  els.sigChip.title = "Mostra i dettagli delle firme";
  els.sigChip.hidden = false;

  const summary = {
    valid: ["Verifica superata", signers.length
      ? "Le firme sono integre: il documento non è stato modificato dopo la firma."
      : "La marca temporale è integra e riferita a questo documento."],
    invalid: ["Attenzione", "Almeno una firma o marca temporale non è valida: il documento potrebbe essere stato alterato."],
    pending: ["Verifica in corso", "Controllo dell'integrità di firme e marche temporali…"],
    unknown: ["Verifica incompleta", certIssue
      ? "Il documento non è stato modificato, ma il certificato di almeno un firmatario non risulta valido alla data della firma."
      : "Non è stato possibile verificare tutte le firme. I dati dei firmatari sono comunque mostrati qui sotto."],
  }[status];
  els.sigBody.append(
    h("div", { class: "summary " + status }, icon(STATUS_ICON[status]),
      h("div", null, h("h3", null, summary[0]), h("p", null, summary[1])))
  );

  const envelopes = layers.filter((l) => l.type === "p7m").length;
  let envelope = 0;
  for (const layer of layers) {
    if (layer.type === "p7m") {
      envelope++;
      els.sigBody.append(h("h3", { class: "layer-title" },
        envelopes > 1 ? `Busta firmata ${envelope} di ${envelopes} (CAdES .p7m)` : "Firma digitale (CAdES .p7m)"));
      if (!layer.signers.length) els.sigBody.append(h("p", { class: "signer-msg" }, "La busta non contiene firme."));
      for (const s of layer.signers) els.sigBody.append(renderSigner(s));
    } else {
      els.sigBody.append(h("h3", { class: "layer-title" }, layer.type === "tsd" ? "Marca temporale (.tsd)" : "Marca temporale (.m7m)"));
      if (!layer.timestamps.length) els.sigBody.append(h("p", { class: "signer-msg" }, "Nessuna marca temporale leggibile."));
      for (const ts of layer.timestamps) els.sigBody.append(renderStamp(ts));
    }
  }
  els.sigBody.append(h("p", { class: "disclaimer" },
    "La verifica controlla l'integrità crittografica di firme e marche temporali e il periodo di validità dei certificati. " +
      "Non controlla l'affidabilità del certificatore né l'eventuale revoca del certificato: " +
      "per una verifica con valore legale usa un servizio di verifica ufficiale."));
}

// "ROSSI MARIO" -> "Rossi Mario"; i nomi già scritti in minuscolo restano invariati.
function niceName(s) {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
}

function taxCode(cert) {
  const sn = cert.subject.attrs.serialNumber && cert.subject.attrs.serialNumber[0];
  if (!sn) return null;
  const v = sn.replace(/^(TINIT-|IT:|TIN:?IT-?)/i, "");
  if (/^[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]$/i.test(v)) return { label: "Codice fiscale", value: v.toUpperCase() };
  if (/^VATIT-?\d{11}$/i.test(sn) || /^\d{11}$/.test(v)) return { label: "Partita IVA", value: v.replace(/^VATIT-?/i, "") };
  return { label: "Identificativo", value: sn };
}

const statusClass = (status) => ({ valid: "ok", invalid: "bad", unknown: "warn" })[status] || null;

function renderSigner(s) {
  const facts = [];
  const add = (label, value, cls) => {
    if (value == null || value === "") return;
    facts.push(h("dt", null, label), h("dd", { class: cls }, value));
  };
  const cert = s.cert;
  if (cert) {
    const tc = taxCode(cert);
    if (tc) add(tc.label, tc.value);
    const org = cert.subject.attrs.O && cert.subject.attrs.O[0];
    if (org && !/^non presente$/i.test(org)) add("Organizzazione", org);
    if (cert.subject.attrs.T) add("Ruolo", cert.subject.attrs.T[0]);
  }
  if (s.signingTime) add("Data firma", `${fmtDateTime(s.signingTime)} (dichiarata dal firmatario)`);
  for (const ts of s.timestamps) {
    add("Marca temporale", `${fmtDateTime(ts.time)}${ts.tsa ? ` · ${ts.tsa}` : ""} — ${STATUS_LABEL[ts.status].toLowerCase()}`, statusClass(ts.status));
  }
  if (cert) {
    const kinds = [];
    if (s.qualified) kinds.push("qualificato (eIDAS)");
    if (s.qscd) kinds.push("su dispositivo sicuro di firma");
    if (kinds.length) add("Certificato", kinds.join(", "));
    const period = `dal ${fmtDate(cert.notBefore)} al ${fmtDate(cert.notAfter)}`;
    const when = s.certCheckedAt ? "alla data della firma" : "oggi";
    if (s.certStatus === "valid") add("Validità", `${period} — valido ${when}`, "ok");
    else if (s.certStatus === "expired") add("Validità", `${period} — scaduto ${when}`, "bad");
    else if (s.certStatus === "notYetValid") add("Validità", `${period} — non ancora valido ${when}`, "bad");
    else add("Validità", period);
    const issuer = cert.issuer.attrs;
    add("Emesso da", [issuer.CN && issuer.CN[0], issuer.O && issuer.O[0]].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · ") || cert.issuer.text);
  }
  add("Algoritmo", s.algorithm);
  if (s.counterSignatures) add("Controfirme", `${s.counterSignatures} (non verificate)`);

  return h("article", { class: "signer" },
    h("div", { class: "signer-head" },
      h("p", { class: "signer-name" }, niceName(s.name)),
      h("span", { class: "badge " + s.status }, icon(STATUS_ICON[s.status]), STATUS_LABEL[s.status])),
    h("p", { class: "signer-msg" }, s.message),
    h("dl", { class: "facts" }, facts),
    cert && h("details", null, h("summary", null, "Dettagli del certificato"),
      h("p", null, h("strong", null, "Titolare: "), cert.subject.text),
      h("p", null, h("strong", null, "Emittente: "), cert.issuer.text),
      h("p", null, h("strong", null, "Numero di serie: "), cert.serialHex.toUpperCase()))
  );
}

function renderStamp(ts) {
  return h("div", { class: "stamp" }, icon("clock"),
    h("div", { class: "stamp-main" },
      h("strong", null, fmtDateTime(ts.time)),
      h("span", null, ts.tsa ? `Rilasciata da ${ts.tsa}. ` : "", ts.message)),
    h("span", { class: "badge " + ts.status }, STATUS_LABEL[ts.status]));
}

function toggleSigPanel(force) {
  const show = force ?? els.sigPanel.hidden;
  els.sigPanel.hidden = !show;
  els.sigChip.setAttribute("aria-expanded", String(show));
  if (show) els.sigClose.focus();
}

/* -------------------------------------------------------- Password PDF */

function askPassword(wrong) {
  return new Promise((resolve) => {
    const dlg = els.passwordDialog;
    els.pwMessage.textContent = wrong
      ? "Password errata. Riprova."
      : "Il documento è protetto. Inserisci la password per aprirlo.";
    els.pwMessage.className = wrong ? "error" : "";
    els.pwInput.value = "";
    const finish = (value) => {
      els.passwordForm.removeEventListener("submit", onSubmit);
      els.pwCancel.removeEventListener("click", onCancel);
      dlg.removeEventListener("cancel", onCancel);
      if (dlg.open) dlg.close();
      resolve(value);
    };
    const onSubmit = (e) => {
      e.preventDefault();
      finish(els.pwInput.value);
    };
    const onCancel = (e) => {
      e.preventDefault();
      finish(null);
    };
    els.passwordForm.addEventListener("submit", onSubmit);
    els.pwCancel.addEventListener("click", onCancel);
    dlg.addEventListener("cancel", onCancel);
    dlg.showModal();
    els.pwInput.focus();
  });
}

/* ------------------------------------------------------------- Stampa */

function clearPrint() {
  if (V) V.clearPrint();
  delete document.body.dataset.print;
  els.pageStyle.textContent = "";
}

function printAltView() {
  clearPrint();
  els.pageStyle.textContent = "@page { margin: 15mm; }";
  document.body.dataset.print = "alt";
  window.print();
}

async function printDocument() {
  if (!doc || printJob) return;
  if (doc.printable === false || doc.type.kind === "binary") {
    toast("Questo tipo di file non può essere stampato dal lettore: salvalo e aprilo con l'applicazione adatta.");
    return;
  }
  if (!doc.pdf) {
    printAltView();
    return;
  }
  const job = (printJob = { cancelled: false, usedPassword: doc.usedPassword });
  const current = doc;
  clearPrint();
  try {
    await V.print(current.pdf, current.data, job);
  } catch (e) {
    job.cancelled = true;
    clearPrint();
    if (!(e && e.name === "AbortError")) {
      console.error(e);
      toast(`Impossibile preparare la stampa: ${(e && e.message) || e}`, "error");
    }
  } finally {
    if (printJob === job) printJob = null;
    idle();
  }
}

// Stampa avviata dal menu del browser: per i testi va bene così,
// per i PDF serve preparare le pagine con il pulsante del lettore.
window.addEventListener("beforeprint", () => {
  if (doc && !doc.pdf && doc.type.kind !== "binary" && !document.body.dataset.print) {
    document.body.dataset.print = "alt";
    els.pageStyle.textContent = "@page { margin: 15mm; }";
  }
});

/* ---------------------------------------------------------- Salvataggio */

function saveBytes(data, name, mime = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = h("a", { href: url, download: name, rel: "noopener" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Contenuto del documento estratto; se l'utente ha compilato dei moduli, include i valori inseriti.
async function documentBytes(d = doc) {
  if (d.pdf && d.pdf.annotationStorage.size > 0) {
    try {
      return await d.pdf.saveDocument();
    } catch (e) {
      console.warn(e);
      // Succede con firme e immagini sui browser senza OffscreenCanvas (Safari prima di iPadOS 16.4).
      toast("Questo browser non riesce a scrivere la firma dentro il PDF, quindi il file è senza. Su iPad e iPhone serve iPadOS/iOS 16.4 o più recente; altrimenti firma da un computer.", "error");
    }
  }
  return d.data;
}

async function downloadDocument() {
  if (!doc) return;
  const current = doc;
  const data = await documentBytes(current);
  saveBytes(data, current.name, current.type.mime);
  current.modificato = false;
}

/* ------------------------------------- Uscire con modifiche non salvate */

let uscitaDlg = null;

// Vero se si può lasciare il documento: niente modifiche, oppure salvato o lasciato perdere dall'utente.
async function lasciaDocumento() {
  if (!doc || !doc.modificato) return true;
  if (!uscitaDlg) {
    uscitaDlg = h("dialog", { class: "modal uscita-dialog", "aria-labelledby": "uscitaTitle" },
      h("form", { method: "dialog" },
        h("h2", { id: "uscitaTitle" }, "Modifiche non salvate"),
        h("p", { class: "uscita-testo" }),
        h("div", { class: "modal-actions" },
          h("button", { class: "btn", type: "submit", value: "annulla" }, "Annulla"),
          h("button", { class: "btn", type: "submit", value: "esci" }, "Esci senza salvare"),
          h("button", { class: "btn primary", type: "submit", value: "salva" }, "Salva"))));
    document.body.append(uscitaDlg);
  }
  uscitaDlg.querySelector(".uscita-testo").textContent =
    `«${doc.name}» ha dati compilati, firme o note che non hai ancora salvato. Se esci, si perdono.`;
  uscitaDlg.returnValue = "";
  const scelta = await new Promise((resolve) => {
    uscitaDlg.addEventListener("close", () => resolve(uscitaDlg.returnValue), { once: true });
    uscitaDlg.showModal();
    uscitaDlg.querySelector(".btn.primary").focus();
  });
  if (scelta === "salva") {
    await downloadDocument();
    return true;
  }
  if (scelta === "esci") {
    doc.modificato = false;
    return true;
  }
  return false;
}

// Chiudere la scheda o la finestra: il browser mostra il suo avviso (il testo non si può scegliere).
window.addEventListener("beforeunload", (e) => {
  if (doc && doc.modificato && !aggiornaPremuto) {
    e.preventDefault();
    e.returnValue = "";
  }
});

/* ------------------------------------------------- Firma e compilazione */

async function addSignature() {
  if (!doc || !doc.pdf) return;
  const current = doc;
  let file;
  try {
    const { chiediFirma } = await import("./firma.js");
    file = await chiediFirma();
  } catch (e) {
    toast(`Firma non disponibile: ${e.message || e}`, "error");
    return;
  }
  if (!file || doc !== current) return;
  try {
    await V.addImage(file);
    els.signBarText.textContent = "Trascina la firma dove serve e ridimensionala dagli angoli.";
    els.signBar.hidden = false;
  } catch (e) {
    toast(`Non riesco a inserire la firma: ${e.message || e}`, "error");
  }
}

function endSignature() {
  if (V) V.endImage();
  els.signBar.hidden = true;
}

async function addNote() {
  if (!doc || !doc.pdf || !V) return;
  endSignature();
  V.setBoxMode(false);
  try {
    await V.startNote();
    els.signBarText.textContent = "Clicca sulla pagina dove vuoi la nota e scrivi. Trascinala per spostarla.";
    els.signBar.hidden = false;
  } catch (e) {
    toast(`Non riesco a inserire la nota: ${e.message || e}`, "error");
  }
}

/** «Spiega con l'AI» di un pezzo selezionato o di un ritaglio (chiamato da testo.js). */
async function explain(req) {
  if (!doc) return;
  const current = doc;
  try {
    const md = await compilatore.spiega(current.name, req, { busy, idle, toast });
    if (doc !== current) return;
    els.sigPanel.hidden = true;
    els.fillPanel.hidden = true;
    compilatore.renderSummary(els.sumPanel, els.sumBody, md, current.name, req.compito === "traduci" ? "traduci" : "spiega");
    // Il pezzo spiegato resta in vista accanto (o sopra) al pannello.
    const sel = window.getSelection();
    const nodo = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
    const el = nodo && (nodo.nodeType === 1 ? nodo : nodo.parentElement);
    if (el && els.viewerContainer.contains(el)) setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 250);
  } catch (e) {
    toast(e.message || String(e), "error");
  }
}

async function fillForm() {
  if (!doc || !doc.pdf) return;
  endSignature();
  let result;
  try {
    result = await compilatore.compila({ name: doc.name, bytes: await documentBytes() }, { busy, idle, toast });
  } catch (e) {
    toast(e.message || String(e), "error");
    return;
  }
  if (!result) return;
  await mostraCompilato(result);
}

// Il modulo compilato si apre raddrizzato come lo era quello di partenza.
let prossimiAngoli = null;

async function mostraCompilato(result) {
  prossimiAngoli = V ? V.angoliRaddrizzati() : null;
  await openBytes(result.bytes, result.name, null, { sostituisci: true });
  if (doc) doc.modificato = true;
  els.sigPanel.hidden = true;
  compilatore.renderReport(els.fillPanel, els.fillBody, result.report, {
    scrivoIo: () => addNote(),
    firma: () => addSignature(),
    imposta: (nome, valore) => (V ? V.impostaCampo(nome, valore) : false),
    mostra: (nome) => V && V.mostraCampo(nome),
    inserisci: async (dati) => {
      try {
        const r = await compilatore.ricompila(dati, { busy, idle, toast });
        if (r) await mostraCompilato(r);
      } catch (e) {
        toast(e.message || String(e), "error");
      }
    },
  });
}

async function summarize() {
  if (!doc) return;
  const current = doc;
  try {
    let pages;
    if (current.pdf) pages = await V.documentText(current.pdf);
    else if (current.type.kind === "xml" || current.type.kind === "text") pages = [decodeText(current.data, current.type.kind)];
    else throw new Error("Questo tipo di file non si può riassumere.");
    const md = await compilatore.riassumi(current.name, pages, { busy, idle, toast });
    if (doc !== current) return;
    els.sigPanel.hidden = true;
    els.fillPanel.hidden = true;
    compilatore.renderSummary(els.sumPanel, els.sumBody, md, current.name, "riassunto");
  } catch (e) {
    toast(e.message || String(e), "error");
  }
}

/* --------------------------------------------------------- Condivisione */

const ENVELOPE_MIME = { p7m: "application/pkcs7-mime", p7s: "application/pkcs7-signature", tsd: "application/timestamped-data" };

function canShareFile(file) {
  try {
    return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [file] }));
  } catch {
    return false;
  }
}

async function shareFile(file) {
  try {
    await navigator.share({ files: [file], title: file.name });
  } catch (e) {
    if (e.name === "AbortError") return; // condivisione annullata dall'utente
    if (e.name === "NotAllowedError") toast("Premi di nuovo «Condividi» per completare la condivisione.");
    else toast(`Condivisione non riuscita: ${e.message || e}`, "error");
  }
}

// Senza documento aperto si condivide il link al lettore.
async function shareApp() {
  const url = new URL("./", location.href).href;
  if (navigator.share) {
    try {
      await navigator.share({ title: "C.A.R.T.A.", text: "C.A.R.T.A., lettore gratuito di PDF e file firmati .p7m: funziona nel browser.", url });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link al lettore copiato negli appunti.");
  } catch {
    toast(url);
  }
}

function closeShareMenu() {
  els.shareMenu.hidden = true;
  els.btnShare.setAttribute("aria-expanded", "false");
}

async function shareDocument() {
  if (!els.shareMenu.hidden) return closeShareMenu();
  if (!doc) return shareApp();
  const current = doc;
  const options = [];
  const extracted = new File([await documentBytes()], current.name, { type: current.type.mime });
  if (canShareFile(extracted)) {
    options.push({ title: current.layers.length ? "Documento estratto" : "Documento", file: extracted });
  }
  if (current.layers.length) {
    // Il file firmato originale conserva il valore legale della firma.
    const ext = (/\.([a-z0-9]+)$/i.exec(current.sourceName) || [])[1] || "";
    const original = new File([current.sourceBytes], current.sourceName, {
      type: ENVELOPE_MIME[ext.toLowerCase()] || "application/octet-stream",
    });
    if (canShareFile(original)) options.push({ title: "File firmato originale", file: original });
  }
  if (!options.length) {
    // Browser senza condivisione di file (o tipo di file non ammesso): si salva il file.
    saveBytes(extracted, current.name, current.type.mime);
    toast("Questo browser non permette di condividere questo file: l'ho salvato, così puoi allegarlo a un'email o a un messaggio.");
    return;
  }
  if (options.length === 1) return shareFile(options[0].file);
  els.shareMenu.replaceChildren(...options.map((o) =>
    h("button", { class: "share-option", type: "button", role: "menuitem", onclick: () => {
      closeShareMenu();
      shareFile(o.file);
    } }, h("strong", null, o.title), h("span", null, o.file.name))));
  els.shareMenu.hidden = false;
  els.btnShare.setAttribute("aria-expanded", "true");
  els.shareMenu.querySelector("button").focus();
}

/* ------------------------------------------------------- Stato comandi */

function updateControls() {
  const hasDoc = !!doc;
  const isPdf = hasDoc && !!doc.pdf;
  els.welcome.hidden = hasDoc;
  if (!hasDoc) {
    els.viewerContainer.hidden = true;
    els.altView.hidden = true;
    els.docTitle.textContent = "";
    document.title = "C.A.R.T.A. · Lettore PDF e P7M";
  }
  els.btnBack.hidden = !(hasDoc && doc.parent);
  if (hasDoc && doc.parent) els.btnBack.title = `Torna a ${doc.parent.name}`;
  els.viewControls.hidden = !isPdf;
  els.btnDownload.disabled = !hasDoc;
  els.btnSign.disabled = !isPdf;
  els.btnFill.hidden = !(isPdf && compilatore.config());
  els.btnSum.hidden = !(hasDoc && compilatore.config() && (isPdf || ["xml", "text"].includes(doc.type.kind)));
  els.btnShare.title = hasDoc ? "Condividi il documento" : "Condividi il lettore";
  els.btnPrint.disabled = !hasDoc || doc.printable === false || doc.type.kind === "binary" || (doc.type.kind === "pdf" && !isPdf);
}

/* ------------------------------------------------------------ Eventi */

const pickFile = () => els.fileInput.click();
els.btnOpen.addEventListener("click", () => (outlookActive ? showHome() : pickFile()));
els.btnOpenBig.addEventListener("click", pickFile);
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  els.fileInput.value = "";
  openFile(file);
});
els.btnBack.addEventListener("click", () => {
  if (doc && doc.parent) openBytes(doc.parent.bytes, doc.parent.name);
});
els.btnDownload.addEventListener("click", downloadDocument);
els.btnShare.addEventListener("click", shareDocument);
document.addEventListener("pointerdown", (e) => {
  if (!els.shareMenu.hidden && !e.target.closest(".share-wrap")) closeShareMenu();
});
els.btnPrint.addEventListener("click", printDocument);
els.btnSign.addEventListener("click", addSignature);
els.signDone.addEventListener("click", endSignature);
els.btnFill.addEventListener("click", fillForm);
els.btnSum.addEventListener("click", summarize);
els.sumClose.addEventListener("click", () => (els.sumPanel.hidden = true));
els.fillClose.addEventListener("click", () => (els.fillPanel.hidden = true));
// Due modi di selezionare: testo (riga per riga, quello normale) o riquadro.
els.btnSelText.addEventListener("click", () => V && V.setBoxMode(false));
els.btnBox.addEventListener("click", () => V && V.setBoxMode(true));
els.btnNote.addEventListener("click", addNote);
els.sigChip.addEventListener("click", () => toggleSigPanel());
els.sigClose.addEventListener("click", () => toggleSigPanel(false));

// Trascina e rilascia.
let dragDepth = 0;
const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add("dragging");
});
window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove("dragging");
  }
});
window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  openFile(e.dataTransfer.files[0]);
});

// Scorciatoie da tastiera.
window.addEventListener("keydown", (e) => {
  if (els.passwordDialog.open) return;
  const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
  const key = e.key.toLowerCase();
  const isPdf = !!(doc && doc.pdf);
  if (mod && key === "o") {
    e.preventDefault();
    pickFile();
  } else if (mod && key === "p") {
    e.preventDefault();
    printDocument();
  } else if (mod && key === "s" && doc) {
    e.preventDefault();
    downloadDocument();
  } else if (mod && key === "f" && isPdf) {
    e.preventDefault();
    V.openFind();
  } else if (mod && (key === "+" || key === "=") && isPdf) {
    e.preventDefault();
    V.zoomIn();
  } else if (mod && key === "-" && isPdf) {
    e.preventDefault();
    V.zoomOut();
  } else if (mod && (key === "z" || key === "y") && isPdf && !V.isEditing() && !e.target.closest("input, textarea, [contenteditable='true']")) {
    e.preventDefault();
    if (key === "y" || e.shiftKey) V.redo();
    else V.undo();
  } else if (mod && key === "0" && isPdf) {
    e.preventDefault();
    V.zoomReset();
  } else if (e.key === "Escape") {
    if (!els.shareMenu.hidden) closeShareMenu();
    else if (!els.signBar.hidden) endSignature();
    else if (V && V.isBoxMode()) V.setBoxMode(false);
    else if (!els.sumPanel.hidden) els.sumPanel.hidden = true;
    else if (!els.fillPanel.hidden) els.fillPanel.hidden = true;
    else if (!els.sigPanel.hidden) toggleSigPanel(false);
    else if (V) V.closeFind();
  }
});

/* ------------------------------------------- Pannello accanto al PDF */

// Spiegazione, riassunto, modulo compilato e firme non coprono il PDF: gli stanno accanto
// (Alessandro, 29/10/2026: «il testo e il PDF insieme»). Lo spazio lo divide il CSS.
{
  const pannelli = [els.sumPanel, els.fillPanel, els.sigPanel];
  const aggiorna = () => document.body.classList.toggle("panel-open", pannelli.some((p) => !p.hidden));
  const mo = new MutationObserver(aggiorna);
  for (const p of pannelli) mo.observe(p, { attributes: true, attributeFilter: ["hidden"] });
}

// La versione in uso, chiesta al service worker attivo: per capire al volo se «Aggiorna» ha preso la nuova.
if (navigator.serviceWorker && navigator.serviceWorker.controller) {
  const canale = new MessageChannel();
  canale.port1.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    els.versione.textContent = `versione ${e.data}`;
    els.versione.hidden = false;
  };
  navigator.serviceWorker.controller.postMessage("versione", [canale.port2]);
}

/* ------------------------------------------------- Esempi da provare */

// Pagina iniziale: due moduli di prova (fac-simile) da aprire con un clic e compilare.
for (const b of document.querySelectorAll("[data-esempio]")) {
  b.addEventListener("click", async () => {
    busy("Apro l'esempio…");
    try {
      const res = await fetch(b.dataset.esempio);
      if (!res.ok) throw new Error(`errore ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      idle();
      await openBytes(bytes, b.dataset.nome);
    } catch (e) {
      idle();
      toast(`Non riesco ad aprire l'esempio: ${e.message || e}`, "error");
    }
  });
}

/* ------------------------------------------------------- Aggiorna */

// Alessandro, 30/10/2026: qualche minuto dopo l'apertura (e poi ogni tanto) si cerca una versione
// nuova; se c'è compare «Aggiorna» e resta finché non lo si preme. La versione nuova si attiva solo
// allora: niente pagina che cambia sotto le mani.
let aggiornaPremuto = false;

function mostraAggiorna() {
  els.btnUpdate.hidden = false;
  els.btnUpdate.classList.add("c-e-nuova");
}

async function cercaAggiornamenti() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    if (reg.waiting && navigator.serviceWorker.controller) return mostraAggiorna();
    await reg.update();
    const nuovo = reg.installing || reg.waiting;
    if (!nuovo || !navigator.serviceWorker.controller) return;
    if (nuovo.state === "installed") return mostraAggiorna();
    nuovo.addEventListener("statechange", () => {
      if (nuovo.state === "installed") mostraAggiorna();
    });
  } catch { /* senza rete: si riprova al prossimo giro */ }
}

async function aggiorna() {
  if (!(await lasciaDocumento())) return;
  aggiornaPremuto = true;
  busy("Aggiorno C.A.R.T.A.…");
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg && reg.waiting) {
      reg.waiting.postMessage("attiva"); // poi «controllerchange» ricarica la pagina
      setTimeout(() => location.reload(), 4000); // se il cambio non arriva, si ricarica comunque
      return;
    }
  } catch { /* si ricarica comunque */ }
  location.reload();
}

els.btnUpdate.addEventListener("click", aggiorna);
if ("serviceWorker" in navigator && !OUTLOOK) {
  setTimeout(cercaAggiornamenti, 3 * 60 * 1000);
  setInterval(cercaAggiornamenti, 15 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") cercaAggiornamenti(); // l'iPad riprende l'app dal sottofondo
  });
}

/* ------------------------------------------------- App installabile */

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  els.btnInstall.hidden = false;
});
els.btnInstall.addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  els.btnInstall.hidden = true;
});
window.addEventListener("appinstalled", () => (els.btnInstall.hidden = true));

// Dentro Outlook niente service worker: il componente aggiuntivo carica sempre l'ultima versione.
if ("serviceWorker" in navigator && window.isSecureContext && !OUTLOOK) {
  const primo = !navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Service worker non registrato:", e));
  // Versione nuova attiva: senza documento aperto si ricarica da sola, altrimenti lo si dice.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (primo) return; // prima installazione, non un aggiornamento
    if (aggiornaPremuto) location.reload();
    else mostraAggiorna(); // passaggio da una versione senza il tasto: lo si mostra e si aspetta
  });
}

// File aperti con "Apri con…" quando l'app è installata (Chrome/Edge).
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (params.files && params.files.length) openFile(await params.files[0].getFile());
  });
}

// File ricevuti tramite "Condividi" (Android), salvati dal service worker.
async function openSharedFile() {
  const params = new URLSearchParams(location.search);
  if (!params.has("condiviso")) return;
  history.replaceState(null, "", location.pathname);
  try {
    const cache = await caches.open(SHARED_CACHE);
    const res = await cache.match("condiviso");
    if (!res) return;
    const name = decodeURIComponent(res.headers.get("X-File-Name") || "documento");
    const bytes = new Uint8Array(await res.arrayBuffer());
    await cache.delete("condiviso");
    openBytes(bytes, name);
  } catch (e) {
    console.warn(e);
  }
}

// Documento passato da un'altra finestra del lettore (pulsante "Apri in una finestra" di Outlook).
function receiveFromOpener() {
  if (!new URLSearchParams(location.search).has("ricevi") || !window.opener) return;
  history.replaceState(null, "", location.pathname);
  window.addEventListener("message", (e) => {
    if (e.source !== window.opener || e.origin !== location.origin || !e.data || e.data.type !== "lettore-file") return;
    openBytes(new Uint8Array(e.data.bytes.buffer || e.data.bytes), e.data.name);
  });
  window.opener.postMessage({ type: "lettore-pronto" }, location.origin);
}

// Anteprima di Outlook classico ed Esplora file: il programma «C.A.R.T.A. anteprima» apre il
// lettore in WebView2 e gli passa il file con un messaggio (vedi il gestore di anteprima).
if (new URLSearchParams(location.search).has("anteprima")) document.body.classList.add("anteprima");
if (window.chrome && window.chrome.webview) {
  window.chrome.webview.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.tipo !== "carta-file" || !d.b64) return;
    const s = atob(d.b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    openBytes(bytes, d.nome || "documento");
  });
  window.chrome.webview.postMessage("carta-pronta");
}

// Estensione «Apri in C.A.R.T.A.» per Chrome ed Edge: il suo script nella pagina consegna il PDF con un
// messaggio (vedi carta_estensione\consegna.js). Solo messaggi dalla pagina stessa, una volta sola.
let estensioneConsegnato = false;
window.addEventListener("message", (e) => {
  const d = e.data;
  if (e.source !== window || e.origin !== location.origin || !d || d.tipo !== "carta-estensione-file" || !d.b64) return;
  window.postMessage({ tipo: "carta-estensione-ricevuto" }, location.origin);
  if (estensioneConsegnato) return;
  estensioneConsegnato = true;
  const s = atob(d.b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  openBytes(bytes, d.nome || "documento.pdf");
});

if (compilatore.linkFromHash()) {
  toast("Compilatore collegato: il pulsante «Compila» compare quando apri un PDF.");
}
compilatore.pickupFromHash({ busy, idle, toast }).then((file) => file && openBytes(file.bytes, file.name));
updateControls();
openSharedFile();
receiveFromOpener();

if (OUTLOOK) {
  import("./outlook.js")
    .then((m) => m.start({
      els, openBytes, showHome, pickFile, toast, busy, idle,
      currentFile: () => (doc ? { bytes: doc.sourceBytes, name: doc.sourceName } : null),
    }))
    .then((active) => {
      outlookActive = active;
      updateControls();
    })
    .catch((e) => console.warn("Modalità Outlook non disponibile:", e));
}

// PDF.js e il suo worker si caricano subito in background, mentre l'utente sceglie
// il file (con il risparmio dati attivo, invece, solo quando servono).
if (!(navigator.connection && navigator.connection.saveData)) loadViewer().catch(() => {});
