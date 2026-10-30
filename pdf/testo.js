// Testo selezionabile oltre a quello di PDF.js: riconoscimento (OCR) delle parti
// in bitmap e selezione a riquadro (Alt+trascina o pulsante), che copia solo il testo
// dentro il rettangolo. L'OCR ha tre gradini: Tesseract nel browser (da solo, sulle
// pagine con immagini), RapidOCR sul compilatore e l'AI del compilatore (a richiesta).

import { config as compilatore, addressSpace } from "./compila.js";

const TESS = new URL("./lib/tesseract/", import.meta.url).href;
const OCR_DPI = 250;
const OCR_MAX_PIXELS = 16e6;
const SERVER_DPI = 200;
const SERVER_MAX_PIXELS = 9e6;
const MIN_CONFIDENCE = 20;
const MIN_IMAGE_SHARE = 0.12; // OCR solo se le immagini coprono almeno il 12% della pagina

let pdfjsLib;
let pdfViewer;
let bus;
let els;
let ui;

const SAFARI = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Android/.test(navigator.userAgent);

let state = new WeakMap(); // documento -> Map(numero pagina -> dati della pagina)
let boxMode = false;
let boxKind = "testo"; // «testo» copia il testo, «foto» fa uno screenshot del rettangolo
const SHOT_SCALE = 3;  // lo screenshot si disegna dal PDF a 3 volte la grandezza a schermo

export function init(lib, viewer, eventBus, elements, hooks) {
  pdfjsLib = lib;
  pdfViewer = viewer;
  bus = eventBus;
  els = elements;
  ui = hooks;
  eventBus.on("textlayerrendered", ({ pageNumber }) => {
    const view = pdfViewer.getPageView(pageNumber - 1);
    if (!view) return;
    drawOcrLayer(view);
    pageData(view).then((d) => d && d.ocr === undefined && queueOcr(view, d)).catch(() => {});
  });
  bindBoxSelection();
  bindCopyFeedback();
  bindOcrMenu();
}

/* ------------------------------------------------------ Dati per pagina */

function pages() {
  const pdf = pdfViewer.pdfDocument;
  if (!pdf) return null;
  if (!state.has(pdf)) state.set(pdf, new Map());
  return state.get(pdf);
}

// Testo di PDF.js e copertura delle immagini, calcolati una volta per pagina.
function pageData(view) {
  const map = pages();
  if (!map) return Promise.resolve(null);
  if (!map.has(view.id)) {
    const page = view.pdfPage;
    const d = { ocr: undefined };
    d.ready = Promise.all([page.getTextContent(), page.getOperatorList()]).then(([tc, ops]) => {
      d.text = textUnits(tc);
      d.imageShare = imageShare(ops, page.view);
      return d;
    });
    map.set(view.id, d);
  }
  const d = map.get(view.id);
  return d.ready.then(() => d);
}

function textUnits(tc) {
  const out = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, dd, e, f] = it.transform;
    const size = Math.hypot(c, dd) || Math.hypot(a, b);
    if (Math.abs(b) > Math.abs(a) * 0.2) continue; // testo ruotato: escluso dal riquadro
    out.push({ x0: e, x1: e + it.width, y0: f - size * 0.2, y1: f + size * 0.8, text: it.str });
  }
  return out;
}

// Quota della pagina coperta da immagini, seguendo le trasformazioni del contenuto.
function imageShare(ops, view) {
  const OPS = pdfjsLib.OPS;
  const paint = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject,
    OPS.paintImageXObjectRepeat, OPS.paintSolidColorImageMask].filter((x) => x !== undefined));
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let area = 0;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, Array.from(args));
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args && args[0] && args[0].length === 6) ctm = mul(ctm, Array.from(args[0]));
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (paint.has(fn)) area += Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
  }
  const pageArea = Math.abs((view[2] - view[0]) * (view[3] - view[1])) || 1;
  return Math.min(1, area / pageArea);
}

/* ----------------------------------------------------------------- OCR */

let tessReady = null;
function tesseract() {
  if (!tessReady) {
    tessReady = new Promise((resolve, reject) => {
      if (window.Tesseract) return resolve(window.Tesseract);
      const s = document.createElement("script");
      s.src = TESS + "tesseract.min.js";
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => reject(new Error("OCR non disponibile"));
      document.head.append(s);
    }).then((T) => T.createWorker("ita", 1, {
      workerPath: TESS + "worker.min.js",
      corePath: TESS + "core/",
      langPath: TESS + "lang/",
      gzip: true,
      workerBlobURL: false,
    }));
    tessReady.catch(() => (tessReady = null));
  }
  return tessReady;
}

const queue = [];
let running = false;

function queueOcr(view, d) {
  if (d.imageShare < MIN_IMAGE_SHARE) {
    d.ocr = null;
    return;
  }
  d.ocr = "pending";
  queue.push({ view, d, pdf: pdfViewer.pdfDocument });
  runQueue();
}

async function runQueue() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      // Prima le pagine visibili più vicine a quella corrente.
      const cur = pdfViewer.currentPageNumber;
      queue.sort((a, b) => Math.abs(a.view.id - cur) - Math.abs(b.view.id - cur));
      const job = queue.shift();
      if (job.pdf !== pdfViewer.pdfDocument) continue;
      showStatus(`Riconosco il testo della pagina ${job.view.id}…`);
      try {
        const lines = await recognize(job.view.pdfPage, job.d.text);
        if (!job.d.manual) job.d.ocr = lines; // un riconoscimento chiesto a mano vale di più
      } catch (e) {
        console.warn("OCR:", e);
        if (!job.d.manual) job.d.ocr = null;
      }
      if (job.pdf === pdfViewer.pdfDocument) drawOcrLayer(job.view);
    }
  } finally {
    running = false;
    showStatus("");
  }
}

async function renderPage(page, dpi, maxPixels) {
  const base = page.getViewport({ scale: 1 });
  let scale = dpi / 72;
  if (base.width * base.height * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (base.width * base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport, annotationMode: pdfjsLib.AnnotationMode.DISABLE }).promise;
  const toPdf = (bb) => {
    const [x0, y0] = viewport.convertToPdfPoint(bb.x0, bb.y1);
    const [x1, y1] = viewport.convertToPdfPoint(bb.x1, bb.y0);
    return { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) };
  };
  return { canvas, toPdf };
}

// Le parole già presenti come testo vero restano a PDF.js.
function coveredBy(textUnits) {
  return (r) => {
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    return textUnits.some((t) => cx >= t.x0 - 1 && cx <= t.x1 + 1 && cy >= t.y0 - 1 && cy <= t.y1 + 1);
  };
}

function makeLine(words) {
  return {
    x0: Math.min(...words.map((w) => w.x0)), x1: Math.max(...words.map((w) => w.x1)),
    y0: Math.min(...words.map((w) => w.y0)), y1: Math.max(...words.map((w) => w.y1)),
    words, text: words.map((w) => w.text).join(" "),
  };
}

function linesFromTesseract(data, toPdf, covered) {
  const lines = [];
  for (const line of data.lines || []) {
    const words = line.words
      .filter((w) => w.confidence >= MIN_CONFIDENCE && w.text.trim())
      .map((w) => ({ ...toPdf(w.bbox), text: w.text.trim() }))
      .filter((w) => !covered(w));
    if (words.length) lines.push(makeLine(words));
  }
  return lines;
}

const overlaps = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.3 * Math.min(a.x1 - a.x0, b.x1 - b.x0)
  && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.3 * Math.min(a.y1 - a.y0, b.y1 - b.y0);

/**
 * Gradino 1: Tesseract nel browser. Con `thorough` fa una seconda passata a «testo sparso»
 * (moduli, tabelle, timbri, scritte isolate) e aggiunge le parole che la prima non aveva.
 */
async function recognize(page, textUnits, thorough = false) {
  const { canvas, toPdf } = await renderPage(page, OCR_DPI, OCR_MAX_PIXELS);
  const covered = coveredBy(textUnits);
  const worker = await tesseract();
  try {
    await worker.setParameters({ tessedit_pageseg_mode: "3" });
    const lines = linesFromTesseract((await worker.recognize(canvas)).data, toPdf, covered);
    if (thorough) {
      await worker.setParameters({ tessedit_pageseg_mode: "11" });
      const found = lines.flatMap((l) => l.words);
      for (const l of linesFromTesseract((await worker.recognize(canvas)).data, toPdf, covered)) {
        const nuove = l.words.filter((w) => !found.some((f) => overlaps(f, w)));
        if (nuove.length) lines.push(makeLine(nuove));
      }
      await worker.setParameters({ tessedit_pageseg_mode: "3" });
    }
    return lines;
  } finally {
    canvas.width = canvas.height = 0;
  }
}

// Gradini 2 e 3: l'immagine della pagina va al compilatore privato (RapidOCR, poi l'AI).
async function recognizeRemote(page, textUnits, level) {
  const cfg = compilatore();
  if (!cfg) throw new Error("Per riconoscere sul server collega prima il compilatore.");
  const { canvas, toPdf } = await renderPage(page, SERVER_DPI, SERVER_MAX_PIXELS);
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error("pagina troppo grande per questo dispositivo");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  let res;
  try {
    res = await fetch(cfg.url + "/ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.chiave },
      body: JSON.stringify({ png: btoa(bin), livello: level }),
      ...addressSpace(cfg.url),
    });
  } catch {
    throw new Error("Compilatore non raggiungibile (serve la rete privata o quella dell'ufficio).");
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.errore || `Il compilatore ha risposto con un errore (${res.status}).`);
  const covered = coveredBy(textUnits);
  const lines = [];
  for (const r of out.righe || []) {
    const box = toPdf(r);
    if (covered(box)) continue;
    // RapidOCR dà righe intere: le parole si stimano in proporzione ai caratteri.
    const n = r.testo.length || 1;
    const words = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(r.testo))) {
      words.push({ x0: box.x0 + ((box.x1 - box.x0) * m.index) / n, x1: box.x0 + ((box.x1 - box.x0) * (m.index + m[0].length)) / n,
        y0: box.y0, y1: box.y1, text: m[0] });
    }
    if (words.length) lines.push(makeLine(words));
  }
  const info = out.info && (out.info.corrette || out.info.aggiunte)
    ? ` (AI: ${out.info.corrette || 0} righe corrette, ${out.info.aggiunte || 0} aggiunte)` : "";
  return { lines, info };
}

const LEVELS = { dispositivo: "sul dispositivo", server: "sul server", ai: "con l'AI" };

/** Il testo riconosciuto con l'OCR di una pagina (stringa vuota se non c'è). */
export function ocrText(pageNumber) {
  const map = pages();
  const d = map && map.get(pageNumber);
  return d && Array.isArray(d.ocr) ? d.ocr.map((l) => l.text).join("\n") : "";
}

/** Riconosce il testo della pagina corrente al gradino scelto; il risultato sostituisce quello di prima. */
export async function recognizePage(level) {
  const view = pdfViewer.getPageView(pdfViewer.currentPageNumber - 1);
  if (!view || !view.pdfPage) return;
  const d = await pageData(view);
  const pdf = pdfViewer.pdfDocument;
  showStatus(`Pagina ${view.id}: riconosco il testo ${LEVELS[level]}…`);
  try {
    let lines;
    let info = "";
    if (level === "dispositivo") lines = await recognize(view.pdfPage, d.text, true);
    else ({ lines, info } = await recognizeRemote(view.pdfPage, d.text, level));
    if (pdf !== pdfViewer.pdfDocument) return;
    d.ocr = lines;
    d.manual = level;
    drawOcrLayer(view);
    const words = lines.reduce((n, l) => n + l.words.length, 0);
    ui.toast(`Pagina ${view.id}: ${lines.length} righe e ${words} parole riconosciute ${LEVELS[level]}${info}. Ora si possono selezionare.`);
  } catch (e) {
    ui.toast(e.message || String(e), "error");
  } finally {
    showStatus("");
  }
}

function bindOcrMenu() {
  const close = () => {
    els.ocrMenu.hidden = true;
    els.btnOcr.setAttribute("aria-expanded", "false");
  };
  const item = (title, sub, level, disabled) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "share-option";
    b.setAttribute("role", "menuitem");
    b.disabled = !!disabled;
    const t = document.createElement("strong");
    t.textContent = title;
    const s = document.createElement("span");
    s.textContent = sub;
    b.append(t, s);
    b.addEventListener("click", () => {
      close();
      recognizePage(level);
    });
    return b;
  };
  els.btnOcr.addEventListener("click", () => {
    if (!els.ocrMenu.hidden) return close();
    const linked = !!compilatore();
    els.ocrMenu.replaceChildren(
      item("Sul dispositivo", "Tesseract, due passate; il file resta qui", "dispositivo", false),
      item("Sul server", linked ? "RapidOCR sul compilatore: più preciso" : "serve il compilatore collegato", "server", !linked),
      item("Con l'AI", linked ? "corregge e completa (tabelle, timbri, scritte a mano)" : "serve il compilatore collegato", "ai", !linked));
    els.ocrMenu.hidden = false;
    els.btnOcr.setAttribute("aria-expanded", "true");
    els.ocrMenu.querySelector("button:not(:disabled)").focus();
  });
  document.addEventListener("pointerdown", (e) => {
    if (!els.ocrMenu.hidden && !e.target.closest(".ocr-wrap")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.ocrMenu.hidden) close();
  });
}

let statusEl = null;
function showStatus(text) {
  if (!statusEl) {
    statusEl = document.createElement("div");
    statusEl.className = "ocr-status";
    statusEl.setAttribute("role", "status");
    document.body.append(statusEl);
  }
  statusEl.textContent = text;
  statusEl.hidden = !text;
}

// Strato invisibile con il testo riconosciuto: si seleziona come quello di PDF.js,
// riga per riga (a fine riga si va a capo).
let measureCtx = null;
function drawOcrLayer(view) {
  const map = pages();
  const d = map && map.get(view.id);
  view.div.querySelector(".ocrLayer")?.remove();
  if (!d || !Array.isArray(d.ocr) || !d.ocr.length) return;
  measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
  const vp = view.viewport;
  const layer = document.createElement("div");
  layer.className = "ocrLayer";
  for (const line of d.ocr) {
    const [x0, y0] = vp.convertToViewportPoint(line.x0, line.y0);
    const [x1, y1] = vp.convertToViewportPoint(line.x1, line.y1);
    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const width = Math.abs(x1 - x0);
    const height = Math.abs(y1 - y0);
    const span = document.createElement("span");
    span.textContent = line.text;
    const size = height * 0.9;
    measureCtx.font = `${size}px sans-serif`;
    const natural = measureCtx.measureText(line.text).width || 1;
    span.style.cssText = `left:${left}px;top:${top}px;font-size:${size}px;transform:scaleX(${width / natural})`;
    layer.append(span, document.createElement("br"));
  }
  const textLayer = view.div.querySelector(".textLayer");
  if (textLayer) textLayer.after(layer);
  else view.div.append(layer);
}

/* ------------------------------------------- Raddrizzare le scansioni */

/** Quanto la pagina è fatta di immagini (0-1): sopra metà è una scansione. */
export async function quotaImmagini(view) {
  const d = await pageData(view);
  return d ? d.imageShare : 0;
}

/**
 * L'angolo (in gradi, tra -5 e +5) di cui è storta una scansione: si cerca l'inclinazione per cui le
 * righe di testo stanno più «in fila», cioè i punti scuri si concentrano su meno righe orizzontali.
 * Prima a passi di 0,5°, poi di 0,05° attorno al migliore.
 */
export async function angoloStorto(view) {
  const page = view.pdfPage;
  const vp = page.getViewport({ scale: 1, rotation: 0 });
  const k = Math.min(1000 / vp.width, 2);
  const c = document.createElement("canvas");
  c.width = Math.round(vp.width * k);
  c.height = Math.round(vp.height * k);
  await page.render({ canvas: c, viewport: page.getViewport({ scale: k, rotation: 0 }) }).promise;
  const { data, width, height } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
  c.width = c.height = 0;
  const xs = [];
  const ys = [];
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      if (data[i] + data[i + 1] + data[i + 2] < 300) {
        xs.push(x - width / 2);
        ys.push(y);
      }
    }
  }
  if (xs.length < 500) return 0;
  const punteggio = (gradi) => {
    const t = Math.tan((gradi * Math.PI) / 180);
    // a fasce di 2 pixel, come il passo con cui si leggono i punti: con fasce da 1 le righe dritte
    // cadrebbero tutte sulle file pari e lo zero vincerebbe sempre
    const righe = new Float64Array(Math.ceil((height + 2 * width) / 2) + 2);
    for (let i = 0; i < xs.length; i++) righe[Math.round((ys[i] + xs[i] * t + width) / 2)]++;
    let s = 0;
    for (const v of righe) s += v * v;
    return s;
  };
  let migliore = 0;
  let best = -1;
  for (let a = -5; a <= 5.001; a += 0.5) {
    const p = punteggio(a);
    if (p > best) [best, migliore] = [p, a];
  }
  const centro = migliore;
  for (let a = centro - 0.5; a <= centro + 0.5001; a += 0.05) {
    const p = punteggio(a);
    if (p > best) [best, migliore] = [p, a];
  }
  return Math.round(migliore * 100) / 100;
}

/* -------------------------------------------------- Selezione a riquadro */

export function setBoxMode(on, kind = "testo") {
  boxMode = on;
  boxKind = kind;
  els.viewerContainer.classList.toggle("box-mode", on);
  els.viewerContainer.classList.toggle("shot-mode", on && kind === "foto");
  els.btnBox.setAttribute("aria-pressed", String(on));
  els.btnSelText.setAttribute("aria-pressed", String(!on));
  if (!on) clearBox();
  hidePill();
}
export const isBoxMode = () => boxMode;
export const setShotMode = (on) => setBoxMode(on, "foto");
export const isShotMode = () => boxMode && boxKind === "foto";

let box = null; // { view, el, x, y, pointerId }

function clearBox() {
  document.querySelectorAll(".boxSel, .boxMark").forEach((el) => el.remove());
}

// Colora, sulla pagina, i pezzi di testo che il riquadro ha preso.
function markParts(view, pageDiv, parts) {
  for (const p of parts) {
    const [ax, ay] = view.viewport.convertToViewportPoint(p.x0, p.yc + p.h / 2);
    const [bx, by] = view.viewport.convertToViewportPoint(p.x1, p.yc - p.h / 2);
    const m = document.createElement("div");
    m.className = "boxMark";
    Object.assign(m.style, {
      left: `${Math.min(ax, bx)}px`, top: `${Math.min(ay, by)}px`,
      width: `${Math.abs(bx - ax)}px`, height: `${Math.abs(by - ay)}px`,
    });
    pageDiv.append(m);
  }
}

function bindBoxSelection() {
  const c = els.viewerContainer;
  c.addEventListener("pointerdown", (e) => {
    if (!(boxMode || e.altKey) || e.button !== 0) return;
    const pageDiv = e.target.closest(".page");
    if (!pageDiv || e.target.closest(".annotationEditorLayer .selectedEditor, .stampEditor")) return;
    const view = pdfViewer.getPageView(Number(pageDiv.dataset.pageNumber) - 1);
    if (!view) return;
    e.preventDefault();
    clearBox();
    window.getSelection().removeAllRanges();
    const r = pageDiv.getBoundingClientRect();
    const el = document.createElement("div");
    el.className = "boxSel";
    pageDiv.append(el);
    // Coordinate dentro l'area del contenuto (senza il bordo di 9px della pagina).
    box = { view, el, pageDiv, x: e.clientX - r.left - pageDiv.clientLeft, y: e.clientY - r.top - pageDiv.clientTop };
    c.setPointerCapture(e.pointerId);
    update(box, e);
  });
  const update = (b, e) => {
    const r = b.pageDiv.getBoundingClientRect();
    const x = Math.max(0, Math.min(b.pageDiv.clientWidth, e.clientX - r.left - b.pageDiv.clientLeft));
    const y = Math.max(0, Math.min(b.pageDiv.clientHeight, e.clientY - r.top - b.pageDiv.clientTop));
    b.x1 = x;
    b.y1 = y;
    Object.assign(b.el.style, {
      left: `${Math.min(b.x, x)}px`, top: `${Math.min(b.y, y)}px`,
      width: `${Math.abs(x - b.x)}px`, height: `${Math.abs(y - b.y)}px`,
    });
  };
  c.addEventListener("pointermove", (e) => box && update(box, e));
  const end = async (e) => {
    if (!box) return;
    const b = box;
    box = null;
    update(b, e);
    if (Math.abs(b.x1 - b.x) < 4 || Math.abs(b.y1 - b.y) < 4) {
      b.el.remove();
      return;
    }
    const [ax, ay] = b.view.viewport.convertToPdfPoint(b.x, b.y);
    const [bx, by] = b.view.viewport.convertToPdfPoint(b.x1, b.y1);
    const rect = { x0: Math.min(ax, bx), x1: Math.max(ax, bx), y0: Math.min(ay, by), y1: Math.max(ay, by) };
    let d = null;
    let parts = [];
    const textReady = pageData(b.view).then((data) => {
      d = data;
      const units = [...(d.text || [])];
      if (Array.isArray(d.ocr)) for (const line of d.ocr) units.push(...line.words);
      const sel = selectInRect(units, rect);
      parts = sel.parts;
      return sel.text;
    });
    const text = await textReady;
    if (text) markParts(b.view, b.pageDiv, parts);
    else if (d && d.ocr === "pending") ui.toast("Sto ancora riconoscendo il testo di questa pagina: il menu vale per l'immagine.");
    const pick = text ? { pages: [{ view: b.view, boxes: boxesFromParts(b.view, parts), text }] } : null;
    showMenu(e.clientX, e.clientY, { text, pick, view: b.view, box: b });
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", () => {
    if (box) box.el.remove();
    box = null;
  });
}

/* ----------------------------------------------------------- Screenshot */

// Il rettangolo (o, con un clic, tutta la pagina) si ridisegna dal PDF ad alta risoluzione:
// l'immagine è nitida anche se a schermo la pagina è piccola.
function renderBox(b) {
  const view = b.view;
  let x0 = Math.min(b.x, b.x1);
  let y0 = Math.min(b.y, b.y1);
  let w = Math.abs(b.x1 - b.x);
  let h = Math.abs(b.y1 - b.y);
  if (w < 4 || h < 4) {
    b.el.remove();
    x0 = 0;
    y0 = 0;
    w = view.viewport.width;
    h = view.viewport.height;
  }
  const f = Math.max(0.25, Math.min(SHOT_SCALE, Math.sqrt(30e6 / (w * h))));
  const png = (async () => {
    const vp = view.pdfPage.getViewport({
      scale: view.viewport.scale * f, rotation: view.viewport.rotation, offsetX: -x0 * f, offsetY: -y0 * f,
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * f);
    canvas.height = Math.round(h * f);
    const pdf = pdfViewer.pdfDocument;
    await view.pdfPage.render({
      canvas, viewport: vp,
      annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE,
      annotationStorage: pdf.annotationStorage,
    }).promise;
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    canvas.width = canvas.height = 0;
    if (!blob) throw new Error("immagine troppo grande");
    return blob;
  })();
  return { png, view, w: Math.round(w * f), h: Math.round(h * f) };
}

function shoot(b) {
  const { png, view, w, h } = renderBox(b);
  // La copia parte subito, dentro il gesto (Safari), con l'immagine ancora da preparare.
  let copied;
  try {
    copied = navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  } catch {
    copied = Promise.reject(new Error("appunti non disponibili"));
  }
  copied.catch(() => {});
  png.then(async (blob) => {
    let ok = true;
    try {
      await copied;
    } catch {
      ok = false;
    }
    showShot(blob, ok, view, w, h);
  }, (e) => ui.toast(`Screenshot non riuscito: ${e.message || e}`, "error"));
}

/* ------------------------------------------- Che cosa è stato copiato */

let card = null;
let pill = null;

// Riquadro in basso con il testo copiato: si vede esattamente cosa è negli appunti.
function showCopied(text, ok, pick = null) {
  hidePill();
  if (!card) {
    card = document.createElement("div");
    card.className = "copy-card";
    card.setAttribute("role", "status");
    card.innerHTML = '<div class="copy-head"><strong></strong><span></span></div><pre></pre><img alt="">'
      + '<div class="copy-actions"><button type="button" class="btn" data-a="salva">Salva immagine</button>'
      + '<button type="button" class="btn" data-a="copia">Copia di nuovo</button>'
      + '<button type="button" class="btn" data-a="sottolinea">Sottolinea</button>'
      + '<button type="button" class="btn" data-a="spiega">Spiega con l\'AI</button>'
      + '<button type="button" class="btn primary" data-a="chiudi">Chiudi</button></div>';
    card.addEventListener("click", async (e) => {
      const a = e.target.closest("button")?.dataset.a;
      if (a === "chiudi") hideCopied();
      if (a === "sottolinea" && card.pick) {
        if (await underline(card.pick)) hideCopied();
        return;
      }
      if (a === "spiega") {
        const shot = card.shot;
        const view = shot ? shot.view : card.pick && card.pick.pages[0] && card.pick.pages[0].view;
        const text = shot ? "" : card.querySelector("pre").textContent;
        hideCopied();
        explain(text, shot ? shot.blob : null, view);
        return;
      }
      if (a === "salva" && card.shot) {
        const link = document.createElement("a");
        link.href = card.querySelector("img").src;
        link.download = card.shot.name;
        document.body.append(link);
        link.click();
        link.remove();
      }
      if (a === "copia" && card.shot) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": card.shot.blob })]);
          card.querySelector("strong").textContent = "✓ Immagine copiata negli appunti";
        } catch {
          card.querySelector("strong").textContent = "Non riesco a copiare l'immagine: usa «Salva immagine»";
        }
        return;
      }
      if (a === "copia") {
        try {
          await navigator.clipboard.writeText(card.querySelector("pre").textContent);
          showCopied(card.querySelector("pre").textContent, true, card.pick);
        } catch {
          showCopied(card.querySelector("pre").textContent, false, card.pick);
        }
      }
    });
    document.body.append(card);
  }
  card.shot = null;
  card.pick = pick && pick.pages.length ? pick : null;
  card.classList.remove("shot");
  card.querySelector('[data-a="sottolinea"]').hidden = !card.pick;
  card.querySelector('[data-a="spiega"]').hidden = !(ui.canExplain && ui.canExplain());
  const lines = text.split("\n").length;
  card.classList.toggle("errore", !ok);
  card.querySelector("strong").textContent = ok ? "✓ Copiato negli appunti" : "Non sono riuscito a copiarlo: selezionalo qui sotto";
  card.querySelector("span").textContent = `${lines} ${lines === 1 ? "riga" : "righe"} · ${text.length} caratteri`;
  card.querySelector("pre").textContent = text;
  card.hidden = false;
}

function showShot(blob, ok, view, w, h) {
  showCopied("", ok);
  const page = view.id;
  const img = card.querySelector("img");
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(blob);
  const base = (document.getElementById("docTitle").textContent || "documento").replace(/\.[^.]+$/, "");
  card.shot = { blob, view, name: `${base} - pagina ${page}.png` };
  card.classList.add("shot");
  card.querySelector("strong").textContent = ok ? "✓ Immagine copiata negli appunti" : "Immagine pronta: usa «Salva immagine»";
  card.querySelector("span").textContent = `${w} × ${h} pixel`;
}

export function hideCopied() {
  if (card) card.hidden = true;
}

function hidePill() {
  if (pill) pill.hidden = true;
}

function selectionInViewer() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
  const node = sel.getRangeAt(0).commonAncestorContainer;
  return els.viewerContainer.contains(node.nodeType === 1 ? node : node.parentNode) ? sel.toString() : "";
}

function bindCopyFeedback() {
  // Selezione normale: un pulsante «Copia» accanto a dove si è lasciato il mouse o il dito.
  els.viewerContainer.addEventListener("pointerup", (e) => {
    if (boxMode || e.altKey || els.viewerContainer.classList.contains("sign-mode")) return;
    setTimeout(() => {
      const text = selectionInViewer();
      if (!text.trim()) return hidePill();
      const pick = pickFromSelection();
      showMenu(e.clientX, e.clientY, { text, pick, view: pick.pages[0] && pick.pages[0].view });
    }, 0);
  });
  // Toccare altrove chiude il menu.
  els.viewerContainer.addEventListener("pointerdown", () => hidePill());
  document.addEventListener("selectionchange", () => {
    if (pill && !pill.hidden && !(pill.ctx && pill.ctx.box) && !selectionInViewer().trim()) hidePill();
  });
  // Ctrl+C (o «Copia» del menu del sistema) sul testo del documento: si mostra cosa è stato copiato.
  document.addEventListener("copy", () => {
    const text = selectionInViewer();
    const pick = text.trim() ? pickFromSelection() : null;
    if (text.trim()) setTimeout(() => showCopied(text, true, pick), 0);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideCopied();
      hidePill();
    }
  });
}

// Testo dentro il rettangolo (coordinate PDF), senza i pezzi: vedi selectInRect.
export function textInRect(units, r) {
  return selectInRect(units, r).text;
}

// Testo dentro il rettangolo (coordinate PDF) e i pezzi presi: taglia anche le parole a
// metà, così si può copiare una colonna senza prendere quella accanto.
export function selectInRect(units, r) {
  const parts = [];
  for (const u of units) {
    const h = u.y1 - u.y0;
    const overlap = Math.min(u.y1, r.y1) - Math.max(u.y0, r.y0);
    if (h <= 0 || overlap < h * 0.5) continue;
    if (u.x1 < r.x0 || u.x0 > r.x1) continue;
    const n = u.text.length;
    const w = (u.x1 - u.x0) / n;
    let from = -1;
    let to = -1;
    for (let i = 0; i < n; i++) {
      const cx = u.x0 + w * (i + 0.5);
      if (cx >= r.x0 && cx <= r.x1) {
        if (from < 0) from = i;
        to = i;
      }
    }
    if (from < 0) continue;
    const text = u.text.slice(from, to + 1);
    if (!text.trim()) continue;
    parts.push({ x0: u.x0 + w * from, x1: u.x0 + w * (to + 1), yc: (u.y0 + u.y1) / 2, h, text });
  }
  parts.sort((a, b) => b.yc - a.yc || a.x0 - b.x0);
  const lines = [];
  for (const p of parts) {
    const line = lines.find((l) => Math.abs(l.yc - p.yc) < Math.min(l.h, p.h) * 0.5);
    if (line) line.parts.push(p);
    else lines.push({ yc: p.yc, h: p.h, parts: [p] });
  }
  lines.sort((a, b) => b.yc - a.yc);
  const text = lines.map((l) => {
    l.parts.sort((a, b) => a.x0 - b.x0);
    let s = "";
    let prev = null;
    for (const p of l.parts) {
      if (prev && p.x0 - prev.x1 > l.h * 0.15 && !s.endsWith(" ") && !p.text.startsWith(" ")) s += " ";
      s += p.text;
      prev = p;
    }
    return s.replace(/\s+/g, " ").trim();
  }).filter(Boolean).join("\n");
  return { text, parts };
}

/* ----------------------------------------------------------- Sottolinea */

// PDF.js non ha l'editor «sottolinea»: si usa quello dell'evidenziatore con una striscia
// sottile sotto ogni riga. Nel PDF salvato è un'evidenziazione rossa sottile, che ogni
// lettore mostra come una sottolineatura. «Evidenzia» è lo stesso editor, giallo, su tutta la riga.

/* -------------------------------------------- Menu dopo la selezione */

// Copia · Sottolinea · Evidenzia · Traduci · Spiega, e col riquadro anche Immagine
// (Alessandro, 29/10/2026). ctx = { text, pick, view, box? }.
function showMenu(x, y, ctx) {
  if (!pill) {
    pill = document.createElement("div");
    pill.className = "copy-pill";
    pill.setAttribute("role", "menu");
    pill.innerHTML = [["copia", "Copia"], ["sottolinea", "Sottolinea"], ["evidenzia", "Evidenzia"], ["traduci", "Traduci"],
      ["spiega", "Spiega"], ["immagine", "Immagine"]].map(([a, t]) => `<button type="button" role="menuitem" data-a="${a}">${t}</button>`).join("");
    pill.addEventListener("pointerdown", (ev) => ev.preventDefault()); // non perdere la selezione
    pill.addEventListener("click", (ev) => {
      const a = ev.target.closest("button")?.dataset.a;
      if (a) menuAction(a, pill.ctx);
    });
    document.body.append(pill);
  }
  pill.ctx = ctx;
  const conTesto = !!(ctx.text && ctx.text.trim());
  const ai = !!(ui.canExplain && ui.canExplain());
  const vis = { copia: conTesto, sottolinea: conTesto, evidenzia: conTesto, traduci: conTesto,
    spiega: ai && (conTesto || !!ctx.box), immagine: !!ctx.box };
  for (const btn of pill.querySelectorAll("button")) btn.hidden = !vis[btn.dataset.a];
  if (!Object.values(vis).some(Boolean)) return hidePill();
  pill.hidden = false;
  const r = pill.getBoundingClientRect();
  pill.style.left = `${Math.max(8, Math.min(window.innerWidth - r.width - 8, x + 8))}px`;
  pill.style.top = `${Math.max(8, Math.min(window.innerHeight - r.height - 8, y + 14))}px`;
}

async function menuAction(a, ctx) {
  hidePill();
  const libera = () => { window.getSelection().removeAllRanges(); };
  if (a === "copia") {
    try {
      await navigator.clipboard.writeText(ctx.text);
      showCopied(ctx.text, true, ctx.pick);
    } catch {
      showCopied(ctx.text, false, ctx.pick);
    }
  } else if (a === "sottolinea" || a === "evidenzia") {
    libera();
    await annotate(ctx.pick, a);
  } else if (a === "traduci") {
    explain(ctx.text, null, ctx.view, "traduci");
  } else if (a === "spiega") {
    if (ctx.text && ctx.text.trim()) explain(ctx.text, null, ctx.view, "spiega");
    else {
      try {
        explain("", await renderBox(ctx.box).png, ctx.view, "spiega");
      } catch (e) {
        ui.toast(`Non riesco a preparare l'immagine: ${e.message || e}`, "error");
      }
    }
  } else if (a === "immagine") {
    shoot(ctx.box);
  }
}

// Riquadri della selezione per pagina, in frazioni della pagina non ruotata (dall'alto),
// come li calcola PDF.js per l'evidenziatore.
function pickFromSelection() {
  const sel = window.getSelection();
  const out = new Map();
  if (!sel || sel.isCollapsed) return { pages: [] };
  const views = [];
  for (let i = 0; i < pdfViewer.pagesCount; i++) {
    const view = pdfViewer.getPageView(i);
    const layer = view && view.div && view.div.querySelector(".textLayer");
    if (layer) views.push({ view, layer, r: layer.getBoundingClientRect() });
  }
  for (let i = 0; i < sel.rangeCount; i++) {
    for (const rc of sel.getRangeAt(i).getClientRects()) {
      if (!rc.width || !rc.height) continue;
      const cx = rc.x + rc.width / 2;
      const cy = rc.y + rc.height / 2;
      const v = views.find((p) => cx >= p.r.left && cx <= p.r.right && cy >= p.r.top && cy <= p.r.bottom);
      if (!v || rc.height > v.r.height * 0.2) continue; // un riquadro grande è un contenitore, non testo
      if (!out.has(v.view)) out.set(v.view, []);
      out.get(v.view).push(toPageBox(v, rc));
    }
  }
  const text = sel.toString();
  return { pages: [...out].map(([view, boxes]) => ({ view, boxes, text })) };
}

function toPageBox({ layer, r }, { x, y, width: w, height: h }) {
  const { left: lx, top: ly, width: W, height: H } = r;
  switch (layer.getAttribute("data-main-rotation")) {
    case "90": return { x: (y - ly) / H, y: 1 - (x + w - lx) / W, width: h / H, height: w / W };
    case "180": return { x: 1 - (x + w - lx) / W, y: 1 - (y + h - ly) / H, width: w / W, height: h / H };
    case "270": return { x: 1 - (y + h - ly) / H, y: (x - lx) / W, width: h / H, height: w / W };
    default: return { x: (x - lx) / W, y: (y - ly) / H, width: w / W, height: h / H };
  }
}

// I pezzi presi dal riquadro (coordinate PDF) nello stesso formato.
function boxesFromParts(view, parts) {
  const [vx0, , vx1, vy1] = view.pdfPage.view;
  const W = vx1 - vx0;
  const H = vy1 - view.pdfPage.view[1];
  return parts.map((p) => ({ x: (p.x0 - vx0) / W, y: (vy1 - (p.yc + p.h / 2)) / H, width: (p.x1 - p.x0) / W, height: p.h / H }));
}

const COLORI = { sottolinea: "#A4161A", evidenzia: "#FFE16A" };

export const underline = (pick) => annotate(pick, "sottolinea");

/** Sottolinea o evidenzia (in giallo) i pezzi scelti. Ritorna quante pagine ha toccato. */
export async function annotate(pick, kind) {
  if (!pick || !pick.pages.length) {
    ui.toast("Seleziona prima il testo.");
    return 0;
  }
  const T = pdfjsLib.AnnotationEditorType;
  if (pdfViewer.annotationEditorMode !== T.HIGHLIGHT) {
    const changed = new Promise((resolve) => bus.on("annotationeditormodechanged", resolve, { once: true }));
    pdfViewer.annotationEditorMode = { mode: T.HIGHLIGHT };
    await changed;
  }
  let n = 0;
  try {
    for (const { view, boxes, text } of pick.pages) {
      const layer = view.annotationEditorLayer && view.annotationEditorLayer.annotationEditorLayer;
      if (!layer || !boxes.length) continue;
      // Sottolinea: la linea di base sta all'80% dell'altezza della riga, la striscia appena sotto.
      const strips = kind === "evidenzia" ? boxes
        : boxes.map((b) => ({ x: b.x, y: b.y + b.height * 0.84, width: b.width, height: Math.max(b.height * 0.07, 0.0008) }));
      const ed = layer.createAndAddNewEditor({ x: 0, y: 0 }, false, { methodOfCreation: "carta_" + kind, boxes: strips, text });
      if (!ed) continue;
      n++;
      // Appena creato è selezionato: il colore va a lui.
      bus.dispatch("switchannotationeditorparams", { source: null, type: pdfjsLib.AnnotationEditorParamsType.HIGHLIGHT_COLOR, value: COLORI[kind] });
      // Una sottolineatura rimasta selezionata prenderebbe i parametri pensati per le note (il colore).
      if (ed._uiManager && ed._uiManager.unselectAll) ed._uiManager.unselectAll();
    }
  } finally {
    // In modalità «evidenzia» PDF.js evidenzierebbe da sé ogni selezione: si torna subito a quella normale.
    pdfViewer.annotationEditorMode = { mode: T.NONE };
  }
  clearBox();
  if (!n) ui.toast("Non ci sono riuscito: riprova con la pagina visibile.", "error");
  return n;
}

/* --------------------------------------------------- Spiega con l'AI */

async function explain(text, blob, view, compito = "spiega") {
  // Traduci senza compilatore collegato: Google Traduttore in una scheda nuova.
  if (compito === "traduci" && !(ui.canExplain && ui.canExplain())) {
    window.open("https://translate.google.com/?sl=auto&tl=it&op=translate&text=" + encodeURIComponent(text.slice(0, 4500)), "_blank", "noopener");
    return;
  }
  if (!ui.spiega) return;
  let contesto = "";
  try {
    if (view) {
      const tc = await view.pdfPage.getTextContent();
      contesto = tc.items.map((it) => (it.str || "") + (it.hasEOL ? "\n" : "")).join("");
      const ocr = ocrText(view.id);
      if (ocr) contesto += "\n" + ocr;
    }
  } catch {
    contesto = "";
  }
  let png = null;
  if (blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    png = btoa(bin);
  }
  ui.spiega({ testo: text, png, contesto, pagina: view ? view.id : null, compito });
}
