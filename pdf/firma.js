// «Firma»: la firma si disegna, si scrive o si prende da una foto, e diventa
// un'immagine con lo sfondo trasparente che PDF.js inserisce nella pagina
// (spostabile e ridimensionabile, salvata nel PDF con «Salva»).
// Non è una firma digitale: è la firma grafica, come quella fatta a penna.

import { h, icon } from "./dom.js";

const STORE = "lettore-firma";
const INK = { nero: "#111111", blu: "#1a3a9c" };
const SCRIPT_FONTS = '"Segoe Script", "Lucida Handwriting", "Brush Script MT", "Apple Chancery", cursive';

let dialog = null;
let resolveFn = null;
let mode = "disegna";
let ink = INK.blu;
let pad;
let strokes = 0;
let photo = null;

function saved() {
  try {
    return localStorage.getItem(STORE);
  } catch {
    return null;
  }
}
function remember(dataUrl) {
  try {
    if (dataUrl) localStorage.setItem(STORE, dataUrl);
    else localStorage.removeItem(STORE);
  } catch { /* archiviazione non disponibile (navigazione privata) */ }
}

/** Apre la finestra e restituisce un File PNG con la firma, oppure null se annullata. */
export function chiediFirma() {
  if (!dialog) build();
  refreshSaved();
  clearPad();
  dialog.querySelector(".sign-typed").value = "";
  photo = null;
  mode = saved() ? "salvata" : "disegna";
  markSaved();
  dialog.showModal();
  return new Promise((resolve) => (resolveFn = resolve));
}

function close(result) {
  dialog.close();
  const r = resolveFn;
  resolveFn = null;
  if (r) r(result);
}

// Una schermata sola, senza schede (Alessandro, 30/10/2026): la firma salvata (se c'è), il riquadro
// dove si firma col dito e, subito sotto, «scrivi il nome» e «da foto». Scrivere o scegliere una
// foto la disegna nello stesso riquadro: si inserisce sempre quello che si vede lì.
function build() {
  pad = h("canvas", { class: "sign-pad", width: 1200, height: 400, "aria-label": "Firma qui" });
  const typed = h("input", { type: "text", class: "sign-typed", placeholder: "…oppure scrivi nome e cognome", autocomplete: "name", "aria-label": "Scrivi la firma" });
  const file = h("input", { type: "file", accept: "image/*", hidden: true });
  const savedImg = h("img", { class: "sign-saved", alt: "Firma salvata" });
  const keep = h("input", { type: "checkbox", id: "signKeep" });

  dialog = h("dialog", { class: "modal sign-dialog", "aria-labelledby": "signTitle" },
    h("h2", { id: "signTitle" }, icon("sign"), " Aggiungi la firma"),
    h("div", { class: "sign-saved-row" },
      h("button", { type: "button", class: "sign-saved-pick", title: "Usa la firma salvata", onclick: () => { mode = "salvata"; clearPad(); markSaved(); } },
        savedImg, h("span", null, "Usa la firma salvata")),
      h("button", { type: "button", class: "btn subtle", onclick: () => { remember(null); refreshSaved(); mode = "disegna"; markSaved(); } }, "Dimentica")),
    h("div", { class: "sign-pad-wrap" }, pad, h("span", { class: "sign-pad-hint" }, "Firma qui col dito, la penna o il mouse")),
    h("div", { class: "sign-alt" },
      typed,
      h("button", { type: "button", class: "btn", onclick: () => file.click() }, icon("shot"), h("span", null, "Da foto")),
      h("button", { type: "button", class: "btn subtle", onclick: () => { clearPad(); typed.value = ""; photo = null; mode = "disegna"; markSaved(); } }, "Cancella")),
    h("div", { class: "sign-options" },
      h("span", { class: "sign-colors" }, "Colore:",
        Object.entries(INK).map(([name, color]) => h("button", {
          type: "button", class: "sign-color", title: name, "aria-label": `Inchiostro ${name}`, style: `--ink:${color}`,
          onclick: () => { ink = color; markInk(); if (mode === "scrivi") redrawTyped(); if (mode === "foto") redrawPhoto(); },
        }))),
      h("label", { class: "sign-keep" }, keep, " Ricorda la firma su questo dispositivo")),
    h("div", { class: "modal-actions" },
      h("button", { type: "button", class: "btn", onclick: () => close(null) }, "Annulla"),
      h("button", { type: "button", class: "btn primary", onclick: async () => {
        const png = await currentSignature();
        if (!png) return;
        if (keep.checked) remember(png);
        close(await dataUrlToFile(png));
      } }, "Inserisci")),
    file);
  document.body.append(dialog);
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    close(null);
  });

  // Disegno a mano libera (mouse, penna, dito), con tratti arrotondati.
  const ctx = pad.getContext("2d");
  let last = null;
  const point = (e) => {
    const r = pad.getBoundingClientRect();
    return [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height),
      e.pressure && e.pointerType === "pen" ? e.pressure : 0.5];
  };
  pad.addEventListener("pointerdown", (e) => {
    // Si comincia a firmare a mano: via il nome scritto o la foto che c'erano nel riquadro.
    if (mode !== "disegna") {
      clearPad();
      typed.value = "";
      photo = null;
      mode = "disegna";
      markSaved();
    }
    pad.setPointerCapture(e.pointerId);
    last = point(e);
    strokes++;
    markEmpty();
  });
  pad.addEventListener("pointermove", (e) => {
    if (!last) return;
    const p = point(e);
    ctx.strokeStyle = ink;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.lineWidth = 3 + p[2] * 5;
    ctx.beginPath();
    ctx.moveTo(last[0], last[1]);
    ctx.quadraticCurveTo(last[0], last[1], (last[0] + p[0]) / 2, (last[1] + p[1]) / 2);
    ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    last = p;
  });
  const stop = () => (last = null);
  pad.addEventListener("pointerup", stop);
  pad.addEventListener("pointercancel", stop);

  typed.addEventListener("input", () => {
    mode = typed.value.trim() ? "scrivi" : "disegna";
    photo = null;
    markSaved();
    redrawTyped();
  });
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    file.value = "";
    if (!f) return;
    try {
      photo = await createImageBitmap(f);
    } catch {
      photo = null;
    }
    if (!photo) return;
    typed.value = "";
    mode = "foto";
    markSaved();
    redrawPhoto();
  });
  markInk();
}

function refreshSaved() {
  const s = saved();
  dialog.querySelector(".sign-saved-row").hidden = !s;
  if (s) dialog.querySelector(".sign-saved").src = s;
}

// La firma salvata è «scelta» finché non si firma, si scrive o si sceglie una foto.
function markSaved() {
  dialog.querySelector(".sign-saved-pick").setAttribute("aria-pressed", String(mode === "salvata"));
  markEmpty();
}

function markEmpty() {
  dialog.querySelector(".sign-pad-wrap").classList.toggle("vuoto", mode === "salvata" || (mode === "disegna" && !strokes));
}

function markInk() {
  for (const b of dialog.querySelectorAll(".sign-color")) b.setAttribute("aria-pressed", String(b.style.getPropertyValue("--ink") === ink));
}

function clearPad() {
  pad.getContext("2d").clearRect(0, 0, pad.width, pad.height);
  strokes = 0;
  if (dialog) markEmpty();
}

function redrawTyped() {
  const ctx = pad.getContext("2d");
  ctx.clearRect(0, 0, pad.width, pad.height);
  strokes = 0;
  const text = dialog.querySelector(".sign-typed").value.trim();
  markEmpty();
  if (!text) return;
  let size = 170;
  do {
    ctx.font = `${size}px ${SCRIPT_FONTS}`;
    size -= 6;
  } while (ctx.measureText(text).width > pad.width - 60 && size > 30);
  ctx.fillStyle = ink;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(text, pad.width / 2, pad.height / 2);
  ctx.textAlign = "start";
}

// Foto: i pixel chiari diventano trasparenti, quelli scuri prendono il colore dell'inchiostro.
function redrawPhoto() {
  const c = pad;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, c.width, c.height);
  strokes = 0;
  markEmpty();
  if (!photo) return;
  const k = Math.min(c.width / photo.width, c.height / photo.height);
  const w = Math.round(photo.width * k);
  const hh = Math.round(photo.height * k);
  ctx.drawImage(photo, (c.width - w) / 2, (c.height - hh) / 2, w, hh);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  // Soglia dal colore medio della carta (i pixel più chiari).
  let sum = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4 * 7) {
    if (d[i + 3] === 0) continue;
    sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    n++;
  }
  const paper = n ? sum / n : 255;
  const hi = paper - 25;
  const lo = paper - 110;
  const [r, g, b] = [1, 3, 5].map((o) => parseInt(ink.slice(o, o + 2), 16));
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const a = l >= hi ? 0 : l <= lo ? 255 : Math.round(((hi - l) / (hi - lo)) * 255);
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
}

// La firma del riquadro (o quella salvata), ritagliata attorno al tratto.
async function currentSignature() {
  if (mode === "salvata") return saved();
  if (mode === "disegna" && !strokes) return null;
  const cropped = crop(pad);
  return cropped ? cropped.toDataURL("image/png") : null;
}

function crop(c) {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 20) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const m = 8;
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m);
  x1 = Math.min(width - 1, x1 + m); y1 = Math.min(height - 1, y1 + m);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d").drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

async function dataUrlToFile(url) {
  const blob = await (await fetch(url)).blob();
  return new File([blob], "firma.png", { type: "image/png" });
}
