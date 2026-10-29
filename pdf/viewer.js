// Parte del lettore che dipende da PDF.js. Viene caricata in background subito
// dopo l'avvio, così l'interfaccia è utilizzabile prima che PDF.js sia pronto.
import * as pdfjsLib from "./lib/pdfjs/pdf.min.mjs";
import * as pdfjsViewer from "./lib/pdfjs/pdf_viewer.min.mjs";
import * as testo from "./testo.js";

const LIB = new URL("./lib/pdfjs/", import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + "pdf.worker.min.mjs";

// Un solo worker, riusato per tutti i documenti.
let worker = null;

const PRINT_DPI = 150;
// Memoria massima per stampare direttamente i canvas (senza codificarli in PNG):
// più prudente su telefoni e dispositivi con poca memoria.
const DIRECT_PRINT_BUDGET =
  (navigator.userAgentData && navigator.userAgentData.mobile) || (navigator.deviceMemory || 4) < 4 ? 80e6 : 200e6;
const ZOOM_DELAY = 400;

export const { PasswordResponses } = pdfjsLib;

let els;
let ui;
let eventBus;
let linkService;
let findController;
let pdfViewer;

/**
 * Collega il visualizzatore all'interfaccia.
 * @param {object} elements elementi della pagina
 * @param {{ hasPdf: () => boolean, busy: Function, idle: Function, h: Function, workerPort: Worker|null }} hooks
 */
export function init(elements, hooks) {
  els = elements;
  ui = hooks;
  worker = new pdfjsLib.PDFWorker({ name: "lettore-pdf", port: hooks.workerPort || null });
  eventBus = new pdfjsViewer.EventBus();
  linkService = new pdfjsViewer.PDFLinkService({
    eventBus,
    externalLinkTarget: pdfjsViewer.LinkTarget.BLANK,
    externalLinkRel: "noopener noreferrer nofollow",
  });
  findController = new pdfjsViewer.PDFFindController({ eventBus, linkService });
  pdfViewer = new pdfjsViewer.PDFViewer({
    container: els.viewerContainer,
    viewer: els.viewer,
    eventBus,
    linkService,
    findController,
    imageResourcesPath: LIB + "images/",
  });
  linkService.setViewer(pdfViewer);
  testo.init(pdfjsLib, pdfViewer, eventBus, els, hooks);
  bindPages();
  bindZoom();
  bindFind();
}

/* ----------------------------------------------------- Apertura PDF */

export function load(data, askPassword) {
  const task = pdfjsLib.getDocument({
    data: data.slice(), // il buffer viene trasferito al worker: l'originale serve per salvare
    worker,
    cMapUrl: LIB + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: LIB + "standard_fonts/",
    wasmUrl: LIB + "wasm/",
    iccUrl: LIB + "iccs/",
    enableXfa: true,
    enableHWA: true, // rendering accelerato dalla GPU
  });
  task.passwordCancelled = false;
  task.onPassword = (updatePassword, reason) => {
    ui.idle();
    askPassword(reason === PasswordResponses.INCORRECT_PASSWORD).then((pw) => {
      if (pw === null) {
        task.passwordCancelled = true;
        task.destroy();
      } else {
        task.usedPassword = true;
        ui.busy("Apertura del documento…");
        updatePassword(pw);
      }
    });
  };
  return task;
}

export function show(pdf) {
  pdfViewer.setDocument(pdf);
  linkService.setDocument(pdf, null);
}

export async function close(task) {
  pdfViewer.setDocument(null);
  linkService.setDocument(null, null);
  await task.destroy().catch(() => {});
}

/* --------------------------------------------------- Pagine e zoom */

function bindPages() {
  eventBus.on("pagesinit", () => {
    pdfViewer.currentScaleValue = window.matchMedia("(max-width: 760px)").matches ? "page-width" : "auto";
    els.pageCount.textContent = `/ ${pdfViewer.pagesCount}`;
    els.pageNumber.max = pdfViewer.pagesCount;
    updatePageControls(pdfViewer.currentPageNumber);
  });
  eventBus.on("pagechanging", ({ pageNumber }) => updatePageControls(pageNumber));

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
  els.btnRotate.addEventListener("click", () => {
    pdfViewer.pagesRotation = (pdfViewer.pagesRotation + 90) % 360;
  });
}

function updatePageControls(page) {
  els.pageNumber.value = page;
  els.btnPrev.disabled = page <= 1;
  els.btnNext.disabled = page >= pdfViewer.pagesCount;
}

export const zoomIn = () => pdfViewer.increaseScale();
export const zoomOut = () => pdfViewer.decreaseScale();
export const zoomReset = () => (pdfViewer.currentScaleValue = "auto");

function bindZoom() {
  eventBus.on("scalechanging", ({ scale, presetValue }) => updateZoomControls(scale, presetValue));
  els.btnZoomIn.addEventListener("click", zoomIn);
  els.btnZoomOut.addEventListener("click", zoomOut);
  els.zoomSelect.addEventListener("change", () => {
    if (els.zoomSelect.value !== "custom") pdfViewer.currentScaleValue = els.zoomSelect.value;
  });

  // Ctrl + rotellina (e pinch sul touchpad).
  let wheelUnusedFactor = 1;
  let touchUnusedFactor = 1;
  els.viewerContainer.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !ui.hasPdf()) return;
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
    isPinchingDisabled: () => !ui.hasPdf(),
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
}

function accumulateFactor(previousScale, factor, unused) {
  if (factor === 1) return [1, unused];
  if ((unused > 1 && factor < 1) || (unused < 1 && factor > 1)) unused = 1;
  const newFactor = Math.floor(previousScale * factor * unused * 100) / (100 * previousScale);
  return [newFactor, factor / newFactor];
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

/* ------------------------------------------------- Testo e immagini */

export const setBoxMode = testo.setBoxMode;
export const isBoxMode = testo.isBoxMode;
export const setShotMode = testo.setShotMode;

/** Il testo di ogni pagina: quello vero del PDF più quello riconosciuto con l'OCR. */
export async function documentText(pdf) {
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let t = "";
    for (const it of tc.items) t += (it.str || "") + (it.hasEOL ? "\n" : "");
    const ocr = testo.ocrText(i);
    out.push([t.trim(), ocr].filter(Boolean).join("\n"));
  }
  return out;
}
export const isShotMode = testo.isShotMode;

let imageGuard = null;

/**
 * Inserisce un'immagine (la firma) al centro della parte visibile della pagina corrente,
 * con l'editor «timbro» di PDF.js: si sposta e si ridimensiona, e «Salva» la scrive nel PDF.
 */
export async function addImage(file, options = { widthPt: 170, maxHeightPt: 70 }) {
  const { AnnotationEditorType } = pdfjsLib;
  if (pdfViewer.annotationEditorMode !== AnnotationEditorType.STAMP) {
    const changed = new Promise((resolve) => eventBus.on("annotationeditormodechanged", resolve, { once: true }));
    pdfViewer.annotationEditorMode = { mode: AnnotationEditorType.STAMP };
    await changed;
  }
  const view = pdfViewer.getPageView(pdfViewer.currentPageNumber - 1);
  const layer = view && view.annotationEditorLayer && view.annotationEditorLayer.annotationEditorLayer;
  if (!layer) throw new Error("pagina non ancora pronta");
  const page = view.div.getBoundingClientRect();
  const box = els.viewerContainer.getBoundingClientRect();
  const top = Math.max(page.top, box.top);
  const bottom = Math.min(page.bottom, box.bottom);
  // PDF.js le darebbe fino a 3/4 della pagina: una firma è larga circa 6 cm (al massimo 2,5 cm
  // d'altezza). La misura va fissata subito, prima che PDF.js finisca di leggere l'immagine.
  const bmp = await createImageBitmap(file);
  let w = options.widthPt;
  let hgt = (w * bmp.height) / bmp.width;
  if (hgt > options.maxHeightPt) [w, hgt] = [(w * options.maxHeightPt) / hgt, options.maxHeightPt];
  bmp.close();
  const editor = layer.createAndAddNewEditor({ offsetX: page.width / 2, offsetY: (top + bottom) / 2 - page.top }, true, { bitmapFile: file });
  if (editor) {
    const [pw, ph] = editor.pageDimensions;
    editor.width = w / pw;
    editor.height = hgt / ph;
  }
  // In modalità «timbro» un clic su un punto vuoto aprirebbe la scelta di un'altra immagine:
  // finché si sistema la firma, quei clic chiudono la modalità invece.
  if (!imageGuard) {
    imageGuard = (e) => {
      if (e.target.closest(".stampEditor, .editToolbar")) return;
      if (!e.target.closest(".annotationEditorLayer")) return;
      e.stopPropagation();
      e.preventDefault();
      endImage();
    };
    els.viewer.addEventListener("pointerdown", imageGuard, true);
  }
}

/** Chiude la modalità di inserimento: le firme restano nella pagina. */
export function endImage() {
  if (imageGuard) els.viewer.removeEventListener("pointerdown", imageGuard, true);
  imageGuard = null;
  if (pdfViewer.annotationEditorMode !== pdfjsLib.AnnotationEditorType.NONE) {
    pdfViewer.annotationEditorMode = { mode: pdfjsLib.AnnotationEditorType.NONE };
  }
}

/* ------------------------------------------------------------ Ricerca */

export function openFind() {
  els.findbar.hidden = false;
  els.btnFind.setAttribute("aria-expanded", "true");
  els.findInput.focus();
  els.findInput.select();
}

export function closeFind() {
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

function bindFind() {
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
}

/* ------------------------------------------------------------- Stampa */

let printUrls = [];
let printFrame = null;
let encoder = null;

// Codifica PNG in un worker (se il browser lo consente), altrimenti sul thread principale.
function canvasToPng(canvas) {
  const mainThread = () => new Promise((resolve) => canvas.toBlob(resolve));
  if (typeof OffscreenCanvas !== "function" || !("convertToBlob" in OffscreenCanvas.prototype) ||
      typeof createImageBitmap !== "function" || (encoder && encoder.broken)) {
    return mainThread();
  }
  if (!encoder) {
    const worker = new Worker(new URL("./print-encoder.js", import.meta.url));
    const pending = new Map();
    worker.onmessage = ({ data }) => {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.blob) resolve(data.blob);
      else reject(new Error(data.error));
    };
    encoder = { worker, pending, seq: 0, broken: false };
    worker.onerror = () => {
      encoder.broken = true;
      for (const { reject } of pending.values()) reject(new Error("worker di codifica non disponibile"));
      pending.clear();
    };
  }
  const { worker, pending } = encoder;
  const id = ++encoder.seq;
  return createImageBitmap(canvas)
    .then((bitmap) => new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, bitmap }, [bitmap]);
    }))
    .catch(mainThread);
}

export function clearPrint() {
  for (const url of printUrls) URL.revokeObjectURL(url);
  printUrls = [];
  for (const canvas of els.printContainer.querySelectorAll("canvas")) canvas.width = canvas.height = 0; // libera la memoria subito
  els.printContainer.replaceChildren();
  if (printFrame) {
    URL.revokeObjectURL(printFrame.src);
    printFrame.remove();
    printFrame = null;
  }
}

// Chrome, Edge & co. su computer stampano il PDF originale con il loro
// visualizzatore integrato: stampa immediata e in qualità vettoriale.
function canPrintNatively() {
  const ua = navigator.userAgentData;
  return !!(
    navigator.pdfViewerEnabled &&
    ua && !ua.mobile &&
    ua.brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand))
  );
}

async function printNatively(bytes) {
  const frame = document.createElement("iframe");
  frame.className = "print-frame";
  frame.title = "Stampa";
  frame.src = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  printFrame = frame;
  await new Promise((resolve, reject) => {
    frame.onload = resolve;
    frame.onerror = reject;
    setTimeout(() => reject(new Error("timeout")), 8000);
    document.body.append(frame);
  });
  frame.contentWindow.focus();
  frame.contentWindow.print();
}

/**
 * Stampa il PDF. `job.cancelled` interrompe la preparazione.
 * @returns {Promise<"native"|"raster">}
 */
export async function print(pdf, data, job) {
  clearPrint();
  const rotation = pdfViewer.pagesRotation;
  const permissions = await pdf.getPermissions().catch(() => null);
  const printAllowed = !permissions || permissions.includes(pdfjsLib.PermissionFlag.PRINT);
  if (canPrintNatively() && !job.usedPassword && rotation === 0 && printAllowed) {
    try {
      // Se l'utente ha compilato dei moduli, stampiamo anche i valori inseriti.
      const bytes = pdf.annotationStorage.size > 0 ? await pdf.saveDocument() : data;
      await printNatively(bytes);
      return "native";
    } catch (e) {
      console.warn("Stampa nativa non riuscita, uso il rendering:", e);
      clearPrint();
    }
  }
  await printRaster(pdf, rotation, job);
  return "raster";
}

// Pagine renderizzate a 150 DPI, più pagine in parallelo: il worker prepara la
// successiva mentre il thread principale disegna. Sui browser Chromium, finché
// la memoria lo consente, si stampano direttamente i canvas (più di 3 volte più
// veloce); le altre pagine diventano immagini PNG codificate in un worker.
async function printRaster(pdf, rotation, job) {
  const first = await pdf.getPage(1);
  const base = first.getViewport({ scale: 1, rotation: (first.rotate + rotation) % 360 });
  const landscape = base.width > base.height;
  // Il formato carta segue la prima pagina; le altre vengono ruotate se serve.
  els.pageStyle.textContent = `@page { size: ${base.width}pt ${base.height}pt; margin: 0; }`;
  const total = pdf.numPages;
  const pageBytes = base.width * base.height * (PRINT_DPI / 72) ** 2 * 4;
  // Pagine stampate direttamente come canvas (solo Chromium, entro il budget di memoria).
  const directPages = navigator.userAgentData ? Math.floor(DIRECT_PRINT_BUDGET / pageBytes) : 0;
  const slots = Array.from({ length: total }, () => ui.h("div", { class: "printedPage" }));
  els.printContainer.append(...slots);
  let next = 0;
  let done = 0;
  const progress = () =>
    ui.busy(`Preparazione della stampa… ${done} di ${total} pagine`, { progress: done / total, onCancel: () => (job.cancelled = true) });
  progress();

  const renderNext = async () => {
    while (next < total) {
      if (job.cancelled) throw new DOMException("Stampa annullata", "AbortError");
      const i = next++;
      const page = i === 0 ? first : await pdf.getPage(i + 1);
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
      page.cleanup();
      if (i < directPages) {
        slots[i].append(canvas);
      } else {
        const blob = await canvasToPng(canvas);
        canvas.width = canvas.height = 0;
        if (!blob) throw new Error("memoria insufficiente per preparare la pagina");
        const url = URL.createObjectURL(blob);
        printUrls.push(url);
        const img = ui.h("img", { src: url, alt: `Pagina ${i + 1}` });
        slots[i].append(img);
        await img.decode().catch(() => {});
      }
      done++;
      progress();
    }
  };
  const lanes = Math.min(total, Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 2) >> 1)));
  await Promise.all(Array.from({ length: lanes }, renderNext));
  if (job.cancelled) throw new DOMException("Stampa annullata", "AbortError");
  document.body.dataset.print = "pdf";
  ui.idle();
  window.print();
}
