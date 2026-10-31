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
    annotationEditorHighlightColors: "rosso=#A4161A,giallo=#FFE16A", // le sottolineature (vedi testo.underline)
  });
  linkService.setViewer(pdfViewer);
  ridisegnaSeCambiaDensita();
  testo.init(pdfjsLib, pdfViewer, eventBus, els, hooks);
  bindPages();
  bindZoom();
  bindFind();
  bindUndo();
  bindSignatureReopen();
  // Quando lo spazio cambia (pannello accanto aperto o chiuso, finestra ridimensionata, iPad
  // ruotato) la pagina si riadatta, se lo zoom è «Automatico», «Larghezza» o «Pagina intera».
  let refit = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(refit);
    refit = requestAnimationFrame(() => {
      // Visore nascosto (vista testo di un p7m, pagina iniziale): niente da riadattare, e PDF.js
      // non può scorrere una pagina invisibile («offsetParent is not set»).
      const c = els.viewerContainer;
      if (c.hidden || !c.offsetParent || !c.clientWidth || !c.clientHeight) return;
      const v = pdfViewer.currentScaleValue;
      if (pdfViewer.pdfDocument && ["auto", "page-width", "page-fit"].includes(v)) pdfViewer.currentScaleValue = v;
    });
  }).observe(els.viewerContainer);
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

/**
 * @param {object} pdf
 * @param {number[]} [angoli] inclinazioni già corrette in un documento precedente (il modulo prima di «Compila»):
 *   il compilato si apre raddrizzato allo stesso modo, senza rimisurare
 */
export function show(pdf, angoli = null) {
  if (angoli) {
    eventBus.on("pagesinit", function applica() {
      eventBus.off("pagesinit", applica);
      if (pdfViewer.pdfDocument !== pdf) return;
      angoli.forEach((a, i) => {
        const v = pdfViewer.getPageView(i);
        if (v && a) giraPagina(v, a);
      });
      raddrizzate.set(pdf, angoli);
    });
  }
  pdfViewer.setDocument(pdf);
  linkService.setDocument(pdf, null);
}

export async function close(task) {
  pdfViewer.setDocument(null);
  linkService.setDocument(null, null);
  await task.destroy().catch(() => {});
}

/* --------------------------------------------------- Pagine e zoom */

// Zoom del browser (Ctrl e rotellina) o finestra spostata su un altro schermo: cambia la densità dei pixel e le
// pagine già disegnate verrebbero solo ingrandite, sgranate (Alessandro, 30/10/2026: «non mi sembra molto
// definita»). Si ridisegnano alla densità nuova.
// Si ascoltano sia la media query della risoluzione sia il ridimensionamento: lo zoom con Ctrl fa scattare tutti e
// due, il cambio di schermo a volte solo il primo.
let densita = window.devicePixelRatio;
function controllaDensita() {
  if (window.devicePixelRatio === densita) return;
  densita = window.devicePixelRatio;
  if (pdfViewer.pdfDocument) pdfViewer.refresh();
}
function ridisegnaSeCambiaDensita() {
  const ascolta = () => matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", () => {
    controllaDensita();
    ascolta();
  }, { once: true });
  ascolta();
  window.addEventListener("resize", controllaDensita);
}

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
  // «Raddrizza»: compare da solo quando la scansione aperta è storta (Alessandro, 30/10/2026).
  els.btnRaddrizza.addEventListener("click", async () => {
    const resto = proposteOra.filter((p) => p.azione !== "raddrizza");
    if (resto.length && avviso && !avviso.hidden) mostraProposte(resto);
    else nascondiAvviso();
    if (await raddrizza()) els.btnRaddrizza.hidden = true;
  });
  eventBus.on("pagesinit", () => {
    els.btnRaddrizza.hidden = true;
    els.tempoLettura.hidden = true;
    nascondiAvviso();
    analizzaDocumento(pdfViewer.pdfDocument);
  });
}

// Aperto un file, si guarda cosa gli serve e lo si propone in una barra sopra la pagina, con i pulsanti pronti
// (Alessandro, 31/10/2026: «controlla se c'è bisogno di raddrizzarlo o riassumerlo o compilarlo»):
//  - Raddrizza: scansione storta (la prima pagina, misurata come fa «Raddrizza»);
//  - Compila: un modulo (campi vuoti, righe ____, quadratini, parole tipiche dei moduli); per le scansioni si
//    aspetta il testo letto dall'OCR;
//  - Riassumi: un documento lungo che non è un modulo.
// Niente proposte su un modulo già compilato da C.A.R.T.A. né se il compilatore non è collegato (Compila, Riassumi).
const PAROLE_MODULO = /il sottoscritt|ragione sociale|codice fiscale|partita iva|p\.\s?iva|nat[oa] a|residente|sede legale|dichiar|compilare|barrare|timbro e firma|firma del|luogo e data|iban|pec\b|n\. rea|legale rappresentante|in qualità di/gi;

// Il modulo appena compilato si apre senza proposte (avrebbe ancora campi vuoti: riproporrebbe «Compila»).
let saltaProposte = false;
export function nienteProposte() {
  saltaProposte = true;
}

async function analizzaDocumento(doc) {
  if (saltaProposte) {
    saltaProposte = false;
    return;
  }
  try {
    await new Promise((r) => setTimeout(r, 300)); // la prima pagina deve avere il suo pdfPage
    const v = pdfViewer.getPageView(0);
    if (!doc || pdfViewer.pdfDocument !== doc || !v || !v.pdfPage) return;
    const proposte = []; // [{ azione, testo }]
    const ancora = () => pdfViewer.pdfDocument === doc;
    // 1. storta?
    const scansione = (await testo.quotaImmagini(v)) >= 0.5;
    if (scansione && !raddrizzate.has(doc)) {
      const a = await testo.angoloStorto(v);
      if (!ancora()) return;
      if (Math.abs(a) >= 0.15) {
        const gradi = Math.abs(a).toLocaleString("it-IT", { maximumFractionDigits: 1 });
        els.btnRaddrizza.title = `Raddrizza la scansione (è storta di ${gradi}°)`;
        els.btnRaddrizza.hidden = false;
        proposte.push({ azione: "raddrizza", testo: `La scansione è storta di ${gradi}°.` });
        mostraProposte(proposte); // subito: il resto può aspettare l'OCR
      }
    }
    // 2. modulo o documento lungo?
    const pagine = Math.min(doc.numPages, 3);
    let campiVuoti = 0;
    let giaCompilato = false;
    let testoPagine = "";
    for (let n = 1; n <= pagine; n++) {
      const pg = await doc.getPage(n);
      for (const a of await pg.getAnnotations()) {
        if (a.subtype !== "Widget" || a.fieldType === "Sig") continue;
        if (String(a.fieldName || "").startsWith("carta_")) giaCompilato = true;
        if (a.fieldType === "Tx" && !a.fieldValue) campiVuoti++;
      }
      testoPagine += (await pg.getTextContent()).items.map((t) => t.str).join(" ") + "\n";
    }
    if (scansione && testoPagine.trim().length < 50) {
      // scansione: si aspetta il testo dell'OCR della prima pagina (al massimo un minuto)
      for (let i = 0; i < 120 && ancora() && !testo.ocrText(1); i++) await new Promise((r) => setTimeout(r, 500));
      testoPagine = testo.ocrText(1);
    }
    if (!ancora()) return;
    const parole = new Set((testoPagine.match(PAROLE_MODULO) || []).map((w) => w.toLowerCase())).size;
    const righeVuote = (testoPagine.match(/_{4,}|\.{6,}/g) || []).length;
    const modulo = !giaCompilato && (campiVuoti >= 3 || parole >= 3 || (parole >= 2 && righeVuote >= 3) || (scansione && parole >= 2));
    const lungo = !modulo && (doc.numPages >= 3 || testoPagine.length >= 4000);
    // tempo di lettura e lingua, da tutto il testo (le scansioni: dalle pagine lette, in proporzione)
    const tutto = await documentText(doc);
    if (!ancora()) return;
    const conTesto = tutto.filter((t) => t.trim()).length || 1;
    const quanteParole = tutto.join(" ").split(/\s+/).filter((w) => /\p{L}/u.test(w)).length * (scansione ? doc.numPages / conTesto : 1);
    const minuti = Math.max(1, Math.round(quanteParole / 200)); // ~200 parole al minuto, lettura attenta
    if (quanteParole >= 60) {
      els.tempoLettura.textContent = `≈ ${minuti} min`;
      els.tempoLettura.title = `Circa ${minuti} ${minuti === 1 ? "minuto" : "minuti"} per leggerlo tutto (${Math.round(quanteParole)} parole)`;
      els.tempoLettura.hidden = false;
    }
    const lingua = linguaDi(tutto.join(" ").slice(0, 20000));
    if (lingua && lingua !== "it" && !els.btnTraduci.hidden) {
      proposte.push({ azione: "traduci", testo: `È in ${NOMI_LINGUE[lingua]}: posso tradurlo.` });
    }
    if (modulo && !els.btnFill.hidden) {
      proposte.push({ azione: "compila", testo: "Sembra un modulo da compilare." });
    } else if (lungo && !els.btnSum.hidden) {
      proposte.push({ azione: "riassumi", testo: `È un documento di ${doc.numPages} ${doc.numPages === 1 ? "pagina" : "pagine"} (circa ${minuti} min di lettura): posso riassumerlo.` });
    }
    if (proposte.length) mostraProposte(proposte);
  } catch (e) {
    console.warn("analisi del documento:", e);
  }
}

// La lingua di un testo, dalle parole più comuni (null se non si capisce o è troppo corto).
const LINGUE = {
  it: ["il", "la", "di", "che", "e", "per", "non", "del", "della", "un", "una", "con", "sono", "nel", "alla"],
  en: ["the", "and", "of", "to", "is", "for", "with", "that", "this", "are", "on", "be", "by", "from", "shall"],
  de: ["der", "die", "und", "das", "nicht", "mit", "ist", "für", "den", "von", "zu", "sich", "auf", "eine"],
  fr: ["le", "les", "des", "et", "est", "pour", "avec", "dans", "une", "du", "au", "pas", "sur", "qui"],
  es: ["el", "los", "las", "y", "es", "para", "con", "que", "una", "del", "por", "se", "como", "al"],
};
const NOMI_LINGUE = { en: "inglese", de: "tedesco", fr: "francese", es: "spagnolo" };
function linguaDi(testoDoc) {
  const parole = testoDoc.toLowerCase().match(/\p{L}+/gu) || [];
  if (parole.length < 40) return null;
  const conti = Object.fromEntries(Object.keys(LINGUE).map((l) => [l, 0]));
  const insiemi = Object.fromEntries(Object.entries(LINGUE).map(([l, ws]) => [l, new Set(ws)]));
  for (const w of parole) for (const l in insiemi) if (insiemi[l].has(w)) conti[l]++;
  const [prima, seconda] = Object.entries(conti).sort((a, b) => b[1] - a[1]);
  return prima[1] >= 8 && prima[1] >= 1.5 * seconda[1] ? prima[0] : null;
}

// La barra delle proposte sopra la pagina, con le azioni lì accanto.
let avviso = null;
const AZIONI = {
  raddrizza: ["Raddrizza", async () => {
    if (await raddrizza()) els.btnRaddrizza.hidden = true;
  }],
  compila: ["Compila", () => els.btnFill.click()],
  riassumi: ["Riassumi", () => els.btnSum.click()],
  traduci: ["Traduci", () => els.btnTraduci.click()],
};
let proposteOra = [];
function mostraProposte(proposte) {
  proposteOra = proposte;
  if (!avviso) {
    avviso = ui.h("div", { class: "avviso-storta", role: "status" });
    els.viewerContainer.parentElement.append(avviso);
  }
  avviso.replaceChildren(
    ui.h("span", { class: "avviso-testo" }, proposte.map((p) => p.testo).join(" ")),
    ...proposte.map((p, i) => ui.h("button", { class: "btn" + (i === 0 ? " primary" : ""), type: "button", "data-azione": p.azione,
      onclick: async () => {
        // fatta un'azione restano le altre (raddrizzata la scansione, resta «Compila»)
        const resto = proposte.filter((x) => x !== p);
        if (resto.length) mostraProposte(resto);
        else nascondiAvviso();
        await AZIONI[p.azione][1]();
      } }, AZIONI[p.azione][0])),
    ui.h("button", { class: "btn", type: "button", onclick: () => nascondiAvviso() }, "Lascia così"));
  avviso.hidden = false;
}
function nascondiAvviso() {
  if (avviso) avviso.hidden = true;
}

// Documenti già raddrizzati, con l'angolo di ogni pagina.
const raddrizzate = new WeakMap();

/** Gli angoli delle pagine raddrizzate del documento aperto (null se non è stato raddrizzato). */
export function angoliRaddrizzati() {
  const a = pdfViewer.pdfDocument && raddrizzate.get(pdfViewer.pdfDocument);
  return a && a.some(Boolean) ? a : null;
}

// Gira l'IMMAGINE (e i campi compilati, che le appartengono), non la pagina intera: il testo letto dall'OCR è già
// nel riferimento raddrizzato, e con la pagina intera girata Chrome in certe zone non riusciva a cominciare la
// selezione (30/10/2026). La rotazione sta nel CSS (vedi .page[data-raddrizza]), così resta anche quando PDF.js
// ridisegna la pagina dopo uno zoom.
function giraPagina(v, a) {
  v.div.dataset.raddrizza = String(a);
  v.div.style.setProperty("--raddrizza", `${a}deg`);
}

async function raddrizza() {
  const doc = pdfViewer.pdfDocument;
  if (!doc) return false;
  const vista = pdfViewer.getPageView(pdfViewer.currentPageNumber - 1);
  if (!vista || (await testo.quotaImmagini(vista)) < 0.5) return false; // non è una scansione
  ui.busy("Cerco l'inclinazione della scansione…");
  let girate = 0;
  let angoloMostrato = 0;
  const angoli = [];
  try {
    for (let i = 0; i < pdfViewer.pagesCount && i < 60; i++) {
      const v = pdfViewer.getPageView(i);
      if (!v || !v.pdfPage) continue;
      if ((await testo.quotaImmagini(v)) < 0.5) continue;
      const a = await testo.angoloStorto(v);
      if (Math.abs(a) < 0.15) continue;
      giraPagina(v, a);
      angoli[i] = a;
      girate++;
      if (i === pdfViewer.currentPageNumber - 1) angoloMostrato = a;
    }
  } finally {
    ui.idle();
  }
  raddrizzate.set(doc, angoli);
  if (!girate) {
    ui.toast("La scansione è già dritta.");
    return false;
  }
  const gradi = Math.abs(angoloMostrato || 0).toLocaleString("it-IT", { maximumFractionDigits: 2 });
  ui.toast(girate === 1 ? `Pagina raddrizzata di ${gradi}°.` : `${girate} pagine raddrizzate (questa di ${gradi}°).`);
  return true;
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
export const trovaFrase = testo.trovaFrase;
export const sottolinea = testo.underline;
export const pageView = (i) => pdfViewer.getPageView(i);
export function vaiPagina(n) {
  pdfViewer.currentPageNumber = Math.min(Math.max(1, n), pdfViewer.pagesCount);
}

let imageGuard = null;
let touchGuard = null;

/**
 * Inserisce un'immagine (la firma) al centro della parte visibile della pagina corrente,
 * con l'editor «timbro» di PDF.js: si sposta e si ridimensiona, e «Salva» la scrive nel PDF.
 */
export async function addImage(file, options = { widthPt: 170, maxHeightPt: 70 }) {
  await startSignMode();
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
}

/** Modalità «sistema la firma»: si sposta e si ridimensiona, finché non si preme «Fatto». */
async function startSignMode() {
  await testo.modalitaEditor(pdfjsLib.AnnotationEditorType.STAMP);
  // iPad (WebKit): trascinando la firma partiva la selezione del testo sotto, non lo spostamento.
  // Finché si sistema la firma il testo non si seleziona, e il dito sulla firma non fa altro.
  els.viewerContainer.classList.add("sign-mode");
  if (!touchGuard) {
    touchGuard = (e) => { if (e.target.closest(".stampEditor")) e.preventDefault(); };
    els.viewer.addEventListener("touchstart", touchGuard, { capture: true, passive: false });
    els.viewer.addEventListener("touchmove", touchGuard, { capture: true, passive: false });
  }
  // In modalità «timbro» un clic su un punto vuoto aprirebbe la scelta di un'altra immagine:
  // si ferma e basta. La firma si fissa solo con «Fatto» (Alessandro, 29/10/2026: toccando
  // fuori per sbaglio sull'iPad la firma si fissava).
  if (!imageGuard) {
    imageGuard = (e) => {
      if (e.target.closest(".stampEditor, .editToolbar")) return;
      if (!e.target.closest(".annotationEditorLayer")) return;
      e.stopPropagation();
      e.preventDefault();
    };
    els.viewer.addEventListener("pointerdown", imageGuard, true);
  }
}

/** Chiude la modalità di inserimento: le firme restano nella pagina. */
export function endImage() {
  if (imageGuard) els.viewer.removeEventListener("pointerdown", imageGuard, true);
  imageGuard = null;
  els.viewerContainer.classList.remove("sign-mode");
  if (touchGuard) {
    els.viewer.removeEventListener("touchstart", touchGuard, { capture: true });
    els.viewer.removeEventListener("touchmove", touchGuard, { capture: true });
  }
  touchGuard = null;
  testo.modalitaNormale(); // senza documento, o con l'editor non ancora pronto, PDF.js rifiuterebbe
}

/**
 * Una firma già fissata si riprende toccandola: torna la modalità per spostarla.
 * In modalità normale PDF.js non le fa ricevere i tocchi, quindi si guarda dove cade il dito.
 */
function bindSignatureReopen() {
  els.viewer.addEventListener("pointerdown", (e) => {
    if (pdfViewer.annotationEditorMode !== pdfjsLib.AnnotationEditorType.NONE || testo.isBoxMode()) return;
    const hit = [...els.viewer.querySelectorAll(".stampEditor")].some((s) => {
      const r = s.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    });
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    startSignMode().then(() => ui.signEditing && ui.signEditing());
  }, true);
}

/* ----------------------------------------------------- Annulla e ripeti */

// La cronologia è quella di PDF.js: firme, spostamenti, ridimensionamenti, note e sottolineature.
export const undo = () => eventBus.dispatch("editingaction", { source: null, name: "undo" });
export const redo = () => eventBus.dispatch("editingaction", { source: null, name: "redo" });
/** Vero se PDF.js sta modificando (firma, nota...): lì Ctrl+Z lo gestisce già lui. */
export const isEditing = () => pdfViewer.annotationEditorMode !== pdfjsLib.AnnotationEditorType.NONE;

function bindUndo() {
  els.btnUndo.disabled = true;
  els.btnRedo.disabled = true;
  eventBus.on("editingstateschanged", ({ details }) => {
    if ("hasSomethingToUndo" in details) els.btnUndo.disabled = !details.hasSomethingToUndo;
    if ("hasSomethingToRedo" in details) els.btnRedo.disabled = !details.hasSomethingToRedo;
  });
  els.btnUndo.addEventListener("click", undo);
  els.btnRedo.addEventListener("click", redo);
}

/* --------------------------------------------------------------- Note */

const NOTE_COLOR = "#A4161A";

/**
 * «Nota»: modalità «testo libero» di PDF.js. Un clic sulla pagina apre un riquadro dove si
 * scrive; si sposta trascinandolo e «Salva» la scrive nel PDF. Si chiude con endImage().
 */
/* ------------------------------------------- Campi del modulo dal pannello */

// Il campo del PDF con questo nome: id dell'annotazione, pagina (da 0), riquadro e tipo. Dalle annotazioni delle
// pagine: getFieldObjects() sui moduli scritti da PyMuPDF torna vuoto.
async function campo(nome) {
  const doc = pdfViewer.pdfDocument;
  if (!doc || !nome) return null;
  for (let i = 0; i < doc.numPages && i < 60; i++) {
    const a = (await (await doc.getPage(i + 1)).getAnnotations()).find((x) => x.fieldName === nome && x.id);
    if (a) return { doc, id: a.id, pagina: i, rect: a.rect, tipo: a.checkBox || a.radioButton ? "checkbox" : "text" };
  }
  return null;
}

/** Porta in vista il campo e lo evidenzia (il cursore ci va dentro, se è da scrivere). */
export async function mostraCampo(nome, c = null) {
  c = c || await campo(nome);
  if (!c) return false;
  pdfViewer.scrollPageIntoView({ pageNumber: c.pagina + 1, destArray: [null, { name: "XYZ" }, c.rect[0] - 60, c.rect[3] + 80, null] });
  setTimeout(() => {
    const el = document.querySelector(`[data-element-id="${c.id}"]`);
    if (!el) return;
    el.classList.add("campo-evidenziato");
    setTimeout(() => el.classList.remove("campo-evidenziato"), 2600);
  }, 350);
  return true;
}

/** Scrive un valore nel campo (o spunta / toglie la casella): subito, nel PDF che si salva. */
export async function impostaCampo(nome, valore) {
  const c = await campo(nome);
  if (!c) return false;
  const casella = c.tipo === "checkbox" || c.tipo === "radiobutton";
  c.doc.annotationStorage.setValue(c.id, { value: casella ? !!valore : String(valore) });
  const el = document.querySelector(`[data-element-id="${c.id}"]`);
  if (el) {
    if (casella) el.checked = !!valore;
    else el.value = String(valore);
  }
  await mostraCampo(nome, c);
  return true;
}

export async function startNote() {
  const { AnnotationEditorParamsType } = pdfjsLib;
  await testo.modalitaEditor(pdfjsLib.AnnotationEditorType.FREETEXT);
  eventBus.dispatch("switchannotationeditorparams", { source: null, type: AnnotationEditorParamsType.FREETEXT_COLOR, value: NOTE_COLOR });
}

export const isNoteMode = () => pdfViewer.annotationEditorMode === pdfjsLib.AnnotationEditorType.FREETEXT;

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
      const entry = pending.get(data.id);
      if (!entry) return; // risposta arrivata dopo un errore del worker
      const { resolve, reject } = entry;
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
