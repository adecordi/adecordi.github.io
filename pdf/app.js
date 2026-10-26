import * as pdfjsLib from "./lib/pdfjs/pdf.min.mjs";
import * as pdfjsViewer from "./lib/pdfjs/pdf_viewer.mjs";
import { unwrap, sniff, innerFileName } from "./p7m.js";

const LIB = new URL("./lib/pdfjs/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + "pdf.worker.min.mjs";

const PRINT_DPI = 150;
const ZOOM_DELAY = 400;
const SHARED_CACHE = "lettore-pdf-condivisi";

const $ = (id) => document.getElementById(id);
const els = {
  toolbar: $("toolbar"),
  btnOpen: $("btnOpen"),
  btnOpenBig: $("btnOpenBig"),
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
  btnFind: $("btnFind"),
  btnDownload: $("btnDownload"),
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

/* --------------------------------------------------------- Visualizzatore */

const eventBus = new pdfjsViewer.EventBus();
const linkService = new pdfjsViewer.PDFLinkService({
  eventBus,
  externalLinkTarget: pdfjsViewer.LinkTarget.BLANK,
  externalLinkRel: "noopener noreferrer nofollow",
});
const findController = new pdfjsViewer.PDFFindController({ eventBus, linkService });
const pdfViewer = new pdfjsViewer.PDFViewer({
  container: els.viewerContainer,
  viewer: els.viewer,
  eventBus,
  linkService,
  findController,
  imageResourcesPath: LIB + "images/",
});
linkService.setViewer(pdfViewer);

/** Documento aperto: { name, data, type, layers, pdf, loadingTask, objectUrl } */
let doc = null;
let openSeq = 0;
let printJob = null;
let printUrls = [];

/* ----------------------------------------------------------- Utilità UI */

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

function icon(name, cls = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}

let toastTimer = 0;
function toast(message, kind = "info") {
  els.toast.textContent = message;
  els.toast.className = "toast" + (kind === "error" ? " error" : "");
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), kind === "error" ? 9000 : 4000);
}
els.toast.addEventListener("click", () => (els.toast.hidden = true));

function busy(text, { progress = null, onCancel = null } = {}) {
  els.busyText.textContent = text;
  els.busyProgress.hidden = progress == null;
  if (progress != null) els.busyBar.style.width = `${Math.round(progress * 100)}%`;
  els.busyCancel.hidden = !onCancel;
  els.busyCancel.onclick = onCancel;
  els.busy.hidden = false;
}
function idle() {
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

async function openBytes(bytes, name) {
  const seq = ++openSeq;
  busy("Apertura del documento…");
  try {
    const { data, fileName, layers } = await unwrap(bytes);
    if (seq !== openSeq) return;
    const type = sniff(data);
    await closeDocument();
    doc = { name: innerFileName(fileName || name, type.ext), sourceName: name, data, type, layers };
    els.docTitle.textContent = doc.name;
    els.docTitle.title = name;
    document.title = `${doc.name} – Lettore PDF e P7M`;
    renderSignatures(layers);
    if (type.kind === "pdf") await showPdf(seq);
    else showOther();
  } catch (e) {
    if (seq !== openSeq) return;
    toast(e && e.message ? e.message : "Impossibile aprire il file.", "error");
  } finally {
    if (seq === openSeq) idle();
    updateControls();
  }
}

async function closeDocument() {
  const old = doc;
  doc = null;
  cancelPrint();
  clearPrint();
  closeFind();
  els.sigPanel.hidden = true;
  els.sigChip.hidden = true;
  els.altView.replaceChildren();
  els.altView.hidden = true;
  if (!old) return;
  if (old.objectUrl) URL.revokeObjectURL(old.objectUrl);
  if (old.loadingTask) {
    pdfViewer.setDocument(null);
    linkService.setDocument(null, null);
    await old.loadingTask.destroy().catch(() => {});
  }
}

function getDocumentParams(data) {
  return {
    data: data.slice(), // il buffer viene trasferito al worker: teniamo l'originale per il salvataggio
    cMapUrl: LIB + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: LIB + "standard_fonts/",
    wasmUrl: LIB + "wasm/",
    iccUrl: LIB + "iccs/",
    enableXfa: true,
  };
}

async function showPdf(seq) {
  els.welcome.hidden = true;
  els.altView.hidden = true;
  els.viewerContainer.hidden = false;
  const task = pdfjsLib.getDocument(getDocumentParams(doc.data));
  doc.loadingTask = task;
  let passwordCancelled = false;
  task.onPassword = (updatePassword, reason) => {
    idle();
    askPassword(reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD).then((pw) => {
      if (pw === null) {
        passwordCancelled = true;
        task.destroy();
      } else {
        busy("Apertura del documento…");
        updatePassword(pw);
      }
    });
  };
  let pdf;
  try {
    pdf = await task.promise;
  } catch (e) {
    if (seq !== openSeq) return;
    els.viewerContainer.hidden = true;
    doc.loadingTask = null;
    task.destroy().catch(() => {});
    if (passwordCancelled) {
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
  pdfViewer.setDocument(pdf);
  linkService.setDocument(pdf, null);
  els.viewerContainer.focus({ preventScroll: true });
}

// Nuovo tentativo di apertura dello stesso PDF (ad esempio dopo aver annullato la password).
function retryPdf() {
  if (!doc) return;
  const seq = ++openSeq;
  busy("Apertura del documento…");
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

function formatXml(text) {
  const parsed = new DOMParser().parseFromString(text, "application/xml");
  if (parsed.getElementsByTagName("parsererror").length) return { text, root: null };
  // Testo mostrato all'utente (non riletto come XML): i valori restano leggibili, senza entità.
  const attrs = (el) => Array.from(el.attributes, (a) => ` ${a.name}="${a.value}"`).join("");
  const lines = [];
  const decl = /^﻿?\s*(<\?xml[^>]*\?>)/.exec(text);
  if (decl) lines.push(decl[1]);
  const walk = (node, depth) => {
    const pad = "  ".repeat(depth);
    switch (node.nodeType) {
      case Node.ELEMENT_NODE: {
        const kids = Array.from(node.childNodes).filter((c) => !(c.nodeType === Node.TEXT_NODE && !c.nodeValue.trim()));
        const open = `<${node.nodeName}${attrs(node)}`;
        if (!kids.length) lines.push(`${pad}${open}/>`);
        else if (kids.length === 1 && kids[0].nodeType === Node.TEXT_NODE) {
          lines.push(`${pad}${open}>${kids[0].nodeValue.trim()}</${node.nodeName}>`);
        } else {
          lines.push(`${pad}${open}>`);
          kids.forEach((k) => walk(k, depth + 1));
          lines.push(`${pad}</${node.nodeName}>`);
        }
        break;
      }
      case Node.TEXT_NODE:
        lines.push(pad + node.nodeValue.trim());
        break;
      case Node.CDATA_SECTION_NODE:
        lines.push(`${pad}<![CDATA[${node.nodeValue}]]>`);
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
  return { text: lines.join("\n"), root: parsed.documentElement };
}

function showOther() {
  els.welcome.hidden = true;
  els.viewerContainer.hidden = true;
  els.altView.hidden = false;
  const { kind, mime } = doc.type;
  if (kind === "xml" || kind === "text") {
    const raw = decodeText(doc.data, kind);
    let text = raw;
    let note = null;
    if (kind === "xml") {
      const formatted = formatXml(raw);
      text = formatted.text;
      if (formatted.root && formatted.root.localName === "FatturaElettronica") {
        note = "Fattura elettronica (FatturaPA) in formato XML. Il contenuto è mostrato così com'è, con i campi in chiaro.";
      }
    }
    const sheet = h("div", { class: "sheet" }, h("pre", { class: "text-view" + (kind === "text" ? " prose" : "") }, text));
    els.altView.replaceChildren(...(note ? [h("div", { class: "sheet-note" }, note), sheet] : [sheet]));
  } else if (kind === "image") {
    doc.objectUrl = URL.createObjectURL(new Blob([doc.data], { type: mime }));
    const img = h("img", { class: "image-view", alt: doc.name });
    img.onerror = () => showBinary("Il browser non riesce a mostrare questa immagine.");
    img.src = doc.objectUrl;
    els.altView.replaceChildren(img);
  } else {
    showBinary();
  }
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

const STATUS_ICON = { valid: "shield-ok", invalid: "shield-bad", unknown: "shield-unknown" };
const STATUS_LABEL = { valid: "Integra", invalid: "Non valida", unknown: "Non verificata" };

function overallStatus(layers) {
  const signers = layers.flatMap((l) => l.signers || []);
  const stamps = layers.flatMap((l) => [...(l.timestamps || []), ...(l.signers || []).flatMap((s) => s.timestamps)]);
  const all = [...signers, ...stamps];
  if (!all.length) return "unknown";
  if (all.some((x) => x.status === "invalid")) return "invalid";
  if (signers.some(certProblem)) return "unknown";
  if (signers.length && signers.every((s) => s.status === "valid")) return "valid";
  if (!signers.length && stamps.every((s) => s.status === "valid")) return "valid";
  return "unknown";
}

const certProblem = (s) => s.certStatus === "expired" || s.certStatus === "notYetValid";

function renderSignatures(layers) {
  els.sigBody.replaceChildren();
  if (!layers.length) {
    els.sigChip.hidden = true;
    return;
  }
  const signers = layers.flatMap((l) => l.signers || []);
  const status = overallStatus(layers);
  const label = els.sigChip.querySelector(".sig-chip-label");
  const use = els.sigChip.querySelector("use");
  use.setAttribute("href", "#i-" + STATUS_ICON[status]);
  els.sigChip.className = "sig-chip " + status;
  let text;
  const certIssue = signers.some(certProblem);
  if (status === "invalid") text = "Firma non valida";
  else if (certIssue) text = signers.some((s) => s.certStatus === "expired") ? "Certificato scaduto" : "Certificato non valido";
  else if (!signers.length) text = status === "valid" ? "Marca temporale" : "Marca non verificata";
  else if (status === "unknown") text = "Firma non verificata";
  else text = signers.length === 1 ? `Firmato da ${niceName(signers[0].name)}` : `Firmato da ${signers.length} persone`;
  label.textContent = text;
  els.sigChip.title = "Mostra i dettagli delle firme";
  els.sigChip.hidden = false;

  const summaryText = {
    valid: signers.length
      ? "Le firme sono integre: il documento non è stato modificato dopo la firma."
      : "La marca temporale è integra e riferita a questo documento.",
    invalid: "Almeno una firma o marca temporale non è valida: il documento potrebbe essere stato alterato.",
    unknown: certIssue
      ? "Il documento non è stato modificato, ma il certificato di almeno un firmatario non risulta valido alla data della firma."
      : "Non è stato possibile verificare tutte le firme. I dati dei firmatari sono comunque mostrati qui sotto.",
  }[status];
  els.sigBody.append(
    h("div", { class: "summary " + status }, icon(STATUS_ICON[status]),
      h("div", null, h("h3", null, { valid: "Verifica superata", invalid: "Attenzione", unknown: "Verifica incompleta" }[status]),
        h("p", null, summaryText)))
  );

  let envelope = 0;
  for (const layer of layers) {
    if (layer.type === "p7m") {
      envelope++;
      const count = layers.filter((l) => l.type === "p7m").length;
      els.sigBody.append(h("h3", { class: "layer-title" },
        count > 1 ? `Busta firmata ${envelope} di ${count} (CAdES .p7m)` : "Firma digitale (CAdES .p7m)"));
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
    add("Marca temporale", `${fmtDateTime(ts.time)}${ts.tsa ? ` · ${ts.tsa}` : ""} — ${STATUS_LABEL[ts.status].toLowerCase()}`,
      ts.status === "valid" ? "ok" : ts.status === "invalid" ? "bad" : "warn");
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

/* --------------------------------------------------- Pagine e zoom */

eventBus.on("pagesinit", () => {
  pdfViewer.currentScaleValue = window.matchMedia("(max-width: 760px)").matches ? "page-width" : "auto";
  els.pageCount.textContent = `/ ${pdfViewer.pagesCount}`;
  els.pageNumber.max = pdfViewer.pagesCount;
  updatePageControls(pdfViewer.currentPageNumber);
});
eventBus.on("pagechanging", ({ pageNumber }) => updatePageControls(pageNumber));
eventBus.on("scalechanging", ({ scale, presetValue }) => updateZoomControls(scale, presetValue));

function updatePageControls(page) {
  els.pageNumber.value = page;
  els.btnPrev.disabled = page <= 1;
  els.btnNext.disabled = page >= pdfViewer.pagesCount;
}

function updateZoomControls(scale, preset) {
  const opts = Array.from(els.zoomSelect.options);
  const match = preset
    ? opts.find((o) => o.value === preset)
    : opts.find((o) => o.value !== "custom" && Math.abs(parseFloat(o.value) - scale) < 1e-3);
  if (match) {
    els.zoomCustom.hidden = true;
    els.zoomSelect.value = match.value;
  } else {
    els.zoomCustom.textContent = `${Math.round(scale * 100)}%`;
    els.zoomCustom.hidden = false;
    els.zoomSelect.value = "custom";
  }
}

els.pageNumber.addEventListener("change", () => {
  const n = Math.min(Math.max(1, parseInt(els.pageNumber.value, 10) || 1), pdfViewer.pagesCount);
  pdfViewer.currentPageNumber = n;
  els.pageNumber.value = n;
});
els.pageNumber.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.pageNumber.dispatchEvent(new Event("change"));
});
els.btnPrev.addEventListener("click", () => pdfViewer.previousPage());
els.btnNext.addEventListener("click", () => pdfViewer.nextPage());
els.btnZoomIn.addEventListener("click", () => pdfViewer.increaseScale());
els.btnZoomOut.addEventListener("click", () => pdfViewer.decreaseScale());
els.zoomSelect.addEventListener("change", () => {
  if (els.zoomSelect.value !== "custom") pdfViewer.currentScaleValue = els.zoomSelect.value;
});
els.btnRotate.addEventListener("click", () => {
  pdfViewer.pagesRotation = (pdfViewer.pagesRotation + 90) % 360;
});

// Zoom con Ctrl + rotellina (e pinch sul touchpad).
let wheelUnusedFactor = 1;
let touchUnusedFactor = 1;
function accumulateFactor(previousScale, factor, unused) {
  if (factor === 1) return [1, unused];
  if ((unused > 1 && factor < 1) || (unused < 1 && factor > 1)) unused = 1;
  const newFactor = Math.floor(previousScale * factor * unused * 100) / (100 * previousScale);
  return [newFactor, factor / newFactor];
}
els.viewerContainer.addEventListener("wheel", (e) => {
  if (!(e.ctrlKey || e.metaKey) || !doc || !doc.pdf) return;
  e.preventDefault();
  const origin = [e.clientX, e.clientY];
  if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(e.deltaY) < 30) {
    let factor;
    [factor, wheelUnusedFactor] = accumulateFactor(pdfViewer.currentScale, Math.exp(-e.deltaY / 100), wheelUnusedFactor);
    pdfViewer.updateScale({ drawingDelay: ZOOM_DELAY, scaleFactor: factor, origin });
  } else if (e.deltaY) {
    pdfViewer.updateScale({ drawingDelay: ZOOM_DELAY, steps: e.deltaY < 0 ? 1 : -1, origin });
  }
}, { passive: false });

// Pinch-to-zoom sui dispositivi touch.
new pdfjsLib.TouchManager({
  container: els.viewerContainer,
  isPinchingDisabled: () => !doc || !doc.pdf,
  onPinching: (origin, prevDistance, distance, dx, dy) => {
    let factor;
    [factor, touchUnusedFactor] = accumulateFactor(pdfViewer.currentScale, distance / prevDistance, touchUnusedFactor);
    pdfViewer.updateScale({ drawingDelay: ZOOM_DELAY, scaleFactor: factor, origin, pan: [dx, dy] });
  },
  onPanning: (dx, dy) => pdfViewer.panBy(dx, dy),
  onPinchEnd: () => {
    touchUnusedFactor = 1;
  },
  signal: new AbortController().signal,
});

/* ------------------------------------------------------------ Ricerca */

function openFind() {
  if (!doc || !doc.pdf) return;
  els.findbar.hidden = false;
  els.btnFind.setAttribute("aria-expanded", "true");
  els.findInput.focus();
  els.findInput.select();
}

function closeFind() {
  if (els.findbar.hidden) return;
  els.findbar.hidden = true;
  els.btnFind.setAttribute("aria-expanded", "false");
  els.findResult.textContent = "";
  eventBus.dispatch("findbarclose", { source: null });
}

function dispatchFind(type, findPrevious = false) {
  eventBus.dispatch("find", {
    source: null,
    type,
    query: els.findInput.value,
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false,
  });
}

function showFindResult(state, matches) {
  const { FindState } = pdfjsViewer;
  els.findResult.classList.toggle("not-found", state === FindState.NOT_FOUND);
  if (!els.findInput.value) els.findResult.textContent = "";
  else if (state === FindState.NOT_FOUND) els.findResult.textContent = "Nessun risultato";
  else if (state === FindState.PENDING) els.findResult.textContent = "Ricerca…";
  else if (matches && matches.total) els.findResult.textContent = `${matches.current} di ${matches.total}`;
}

eventBus.on("updatefindcontrolstate", ({ state, matchesCount }) => showFindResult(state, matchesCount));
eventBus.on("updatefindmatchescount", ({ matchesCount }) => showFindResult(pdfjsViewer.FindState.FOUND, matchesCount));

els.btnFind.addEventListener("click", () => (els.findbar.hidden ? openFind() : closeFind()));
els.findInput.addEventListener("input", () => dispatchFind(""));
els.findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    dispatchFind("again", e.shiftKey);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeFind();
  }
});
els.findNext.addEventListener("click", () => dispatchFind("again", false));
els.findPrev.addEventListener("click", () => dispatchFind("again", true));
els.findClose.addEventListener("click", closeFind);

/* ------------------------------------------------------------- Stampa */

function clearPrint() {
  for (const url of printUrls) URL.revokeObjectURL(url);
  printUrls = [];
  els.printContainer.replaceChildren();
  delete document.body.dataset.print;
  els.pageStyle.textContent = "";
}

function cancelPrint() {
  if (printJob) printJob.cancelled = true;
}

async function printDocument() {
  if (!doc || printJob) return;
  if (doc.printable === false || doc.type.kind === "binary") {
    toast("Questo tipo di file non può essere stampato dal lettore: salvalo e aprilo con l'applicazione adatta.");
    return;
  }
  if (!doc.pdf) {
    clearPrint();
    els.pageStyle.textContent = "@page { margin: 15mm; }";
    document.body.dataset.print = "alt";
    window.print();
    return;
  }
  const job = (printJob = { cancelled: false });
  const pdf = doc.pdf;
  clearPrint();
  try {
    const rotation = pdfViewer.pagesRotation;
    const first = await pdf.getPage(1);
    const base = first.getViewport({ scale: 1, rotation: (first.rotate + rotation) % 360 });
    const landscape = base.width > base.height;
    // Il formato carta segue la prima pagina; le altre vengono ruotate se serve.
    els.pageStyle.textContent = `@page { size: ${base.width}pt ${base.height}pt; margin: 0; }`;
    const total = pdf.numPages;
    for (let i = 1; i <= total; i++) {
      if (job.cancelled) throw new DOMException("Stampa annullata", "AbortError");
      busy(`Preparazione della stampa… pagina ${i} di ${total}`, { progress: (i - 1) / total, onCancel: cancelPrint });
      const page = i === 1 ? first : await pdf.getPage(i);
      let rot = (page.rotate + rotation) % 360;
      const natural = page.getViewport({ scale: 1, rotation: rot });
      if (natural.width > natural.height !== landscape && natural.width !== natural.height) rot = (rot + 90) % 360;
      const viewport = page.getViewport({ scale: PRINT_DPI / 72, rotation: rot });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({
        canvas,
        viewport,
        intent: "print",
        annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE,
        printAnnotationStorage: pdf.annotationStorage.print,
      }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve));
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error("memoria insufficiente per preparare la pagina");
      const url = URL.createObjectURL(blob);
      printUrls.push(url);
      const img = h("img", { src: url, alt: `Pagina ${i}` });
      els.printContainer.append(h("div", { class: "printedPage" }, img));
      page.cleanup();
    }
    busy("Invio alla stampante…", { progress: 1 });
    await Promise.all(Array.from(els.printContainer.querySelectorAll("img"), (img) => img.decode().catch(() => {})));
    if (job.cancelled || doc === null || doc.pdf !== pdf) throw new DOMException("Stampa annullata", "AbortError");
    document.body.dataset.print = "pdf";
    idle();
    window.print();
  } catch (e) {
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

async function downloadDocument() {
  if (!doc) return;
  let data = doc.data;
  try {
    // Se l'utente ha compilato dei moduli, salviamo anche i valori inseriti.
    if (doc.pdf && doc.pdf.annotationStorage.size > 0) data = await doc.pdf.saveDocument();
  } catch (e) {
    console.warn(e);
  }
  const url = URL.createObjectURL(new Blob([data], { type: doc.type.mime }));
  const a = h("a", { href: url, download: doc.name, rel: "noopener" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
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
    document.title = "Lettore PDF e P7M";
  }
  els.viewControls.hidden = !isPdf;
  els.btnDownload.disabled = !hasDoc;
  els.btnPrint.disabled = !hasDoc || doc.printable === false || doc.type.kind === "binary" || (doc.type.kind === "pdf" && !isPdf);
}

/* ------------------------------------------------------------ Eventi */

const pickFile = () => els.fileInput.click();
els.btnOpen.addEventListener("click", pickFile);
els.btnOpenBig.addEventListener("click", pickFile);
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  els.fileInput.value = "";
  openFile(file);
});
els.btnDownload.addEventListener("click", downloadDocument);
els.btnPrint.addEventListener("click", printDocument);
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
    openFind();
  } else if (mod && (key === "+" || key === "=") && isPdf) {
    e.preventDefault();
    pdfViewer.increaseScale();
  } else if (mod && key === "-" && isPdf) {
    e.preventDefault();
    pdfViewer.decreaseScale();
  } else if (mod && key === "0" && isPdf) {
    e.preventDefault();
    pdfViewer.currentScaleValue = "auto";
  } else if (e.key === "Escape") {
    if (!els.sigPanel.hidden) toggleSigPanel(false);
    else closeFind();
  }
});

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

if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Service worker non registrato:", e));
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

updateControls();
openSharedFile();
