// Testo selezionabile oltre a quello di PDF.js: riconoscimento (OCR) delle parti
// in bitmap, fatto nel browser con Tesseract, e selezione a riquadro (Alt+trascina
// o pulsante «Riquadro»), che copia solo il testo dentro il rettangolo.

const TESS = new URL("./lib/tesseract/", import.meta.url).href;
const OCR_DPI = 200;
const OCR_MAX_PIXELS = 12e6;
const MIN_IMAGE_SHARE = 0.12; // OCR solo se le immagini coprono almeno il 12% della pagina

let pdfjsLib;
let pdfViewer;
let els;
let ui;

const SAFARI = /AppleWebKit/.test(navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Android/.test(navigator.userAgent);

let state = new WeakMap(); // documento -> Map(numero pagina -> dati della pagina)
let boxMode = false;

export function init(lib, viewer, eventBus, elements, hooks) {
  pdfjsLib = lib;
  pdfViewer = viewer;
  els = elements;
  ui = hooks;
  eventBus.on("textlayerrendered", ({ pageNumber }) => {
    const view = pdfViewer.getPageView(pageNumber - 1);
    if (!view) return;
    drawOcrLayer(view);
    pageData(view).then((d) => d && d.ocr === undefined && queueOcr(view, d)).catch(() => {});
  });
  bindBoxSelection();
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
        job.d.ocr = await recognize(job.view.pdfPage, job.d.text);
      } catch (e) {
        console.warn("OCR:", e);
        job.d.ocr = null;
      }
      if (job.pdf === pdfViewer.pdfDocument) drawOcrLayer(job.view);
    }
  } finally {
    running = false;
    showStatus("");
  }
}

async function recognize(page, textUnits) {
  const base = page.getViewport({ scale: 1 });
  let scale = OCR_DPI / 72;
  if (base.width * base.height * scale * scale > OCR_MAX_PIXELS) scale = Math.sqrt(OCR_MAX_PIXELS / (base.width * base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvas, viewport, annotationMode: pdfjsLib.AnnotationMode.DISABLE }).promise;
  const worker = await tesseract();
  const { data } = await worker.recognize(canvas);
  canvas.width = canvas.height = 0;
  const toPdf = (bb) => {
    const [x0, y0] = viewport.convertToPdfPoint(bb.x0, bb.y1);
    const [x1, y1] = viewport.convertToPdfPoint(bb.x1, bb.y0);
    return { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) };
  };
  // Le parole già presenti come testo vero restano a PDF.js.
  const covered = (r) => {
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    return textUnits.some((t) => cx >= t.x0 - 1 && cx <= t.x1 + 1 && cy >= t.y0 - 1 && cy <= t.y1 + 1);
  };
  const lines = [];
  for (const line of data.lines || []) {
    const words = line.words
      .filter((w) => w.confidence >= 30 && w.text.trim())
      .map((w) => ({ ...toPdf(w.bbox), text: w.text.trim() }))
      .filter((w) => !covered(w));
    if (!words.length) continue;
    const box = {
      x0: Math.min(...words.map((w) => w.x0)), x1: Math.max(...words.map((w) => w.x1)),
      y0: Math.min(...words.map((w) => w.y0)), y1: Math.max(...words.map((w) => w.y1)),
    };
    lines.push({ ...box, words, text: words.map((w) => w.text).join(" ") });
  }
  return lines;
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

/* -------------------------------------------------- Selezione a riquadro */

export function setBoxMode(on) {
  boxMode = on;
  els.viewerContainer.classList.toggle("box-mode", on);
  els.btnBox.setAttribute("aria-pressed", String(on));
  if (!on) clearBox();
}
export const isBoxMode = () => boxMode;

let box = null; // { view, el, x, y, pointerId }

function clearBox() {
  document.querySelectorAll(".boxSel").forEach((el) => el.remove());
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
    const textReady = pageData(b.view).then((data) => {
      d = data;
      const units = [...(d.text || [])];
      if (Array.isArray(d.ocr)) for (const line of d.ocr) units.push(...line.words);
      return textInRect(units, rect);
    });
    // Safari accetta la copia solo se parte subito, dentro il gesto: gli si passa il testo
    // ancora da calcolare (ClipboardItem con una promessa), come raccomanda Apple.
    let copied = null;
    if (SAFARI && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      copied = navigator.clipboard.write([new ClipboardItem({
        "text/plain": textReady.then((t) => (t ? new Blob([t], { type: "text/plain" }) : Promise.reject(new Error("vuoto")))),
      })]);
      copied.catch(() => {});
    }
    const text = await textReady;
    if (!text) {
      ui.toast(d.ocr === "pending" ? "Sto ancora riconoscendo il testo di questa pagina: riprova tra poco." : "Nessun testo nel riquadro.");
      return;
    }
    try {
      await (copied || navigator.clipboard.writeText(text));
      const lines = text.split("\n").length;
      ui.toast(`Copiato (${lines} ${lines === 1 ? "riga" : "righe"}): «${text.length > 60 ? text.slice(0, 60) + "…" : text}»`);
    } catch {
      ui.toast("Non riesco a copiare negli appunti in questo browser.", "error");
    }
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", () => {
    if (box) box.el.remove();
    box = null;
  });
}

// Testo dentro il rettangolo (coordinate PDF): taglia anche le parole a metà, così
// si può copiare una colonna senza prendere quella accanto.
export function textInRect(units, r) {
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
  return lines.map((l) => {
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
}
