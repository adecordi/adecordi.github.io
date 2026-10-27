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
  setMode(saved() ? "salvata" : "disegna");
  dialog.showModal();
  return new Promise((resolve) => (resolveFn = resolve));
}

function close(result) {
  dialog.close();
  const r = resolveFn;
  resolveFn = null;
  if (r) r(result);
}

function build() {
  const tabs = [
    ["salvata", "Firma salvata"],
    ["disegna", "Disegna"],
    ["scrivi", "Scrivi"],
    ["foto", "Da foto"],
  ];
  pad = h("canvas", { class: "sign-pad", width: 1200, height: 400, "aria-label": "Disegna qui la firma" });
  const typed = h("input", { type: "text", class: "sign-typed", placeholder: "Nome e cognome", autocomplete: "name", "aria-label": "Testo della firma" });
  const file = h("input", { type: "file", accept: "image/*", hidden: true });
  const savedImg = h("img", { class: "sign-saved", alt: "Firma salvata" });
  const keep = h("input", { type: "checkbox", id: "signKeep" });

  dialog = h("dialog", { class: "modal sign-dialog", "aria-labelledby": "signTitle" },
    h("h2", { id: "signTitle" }, icon("sign"), " Aggiungi la firma"),
    h("div", { class: "sign-tabs", role: "tablist" }, tabs.map(([k, label]) =>
      h("button", { type: "button", role: "tab", class: "sign-tab", "data-mode": k, onclick: () => setMode(k) }, label))),
    h("div", { class: "sign-area" },
      h("div", { class: "sign-pane", "data-pane": "salvata" }, savedImg,
        h("button", { type: "button", class: "btn subtle", onclick: () => { remember(null); refreshSaved(); setMode("disegna"); } }, "Dimentica questa firma")),
      h("div", { class: "sign-pane", "data-pane": "disegna" }, pad,
        h("button", { type: "button", class: "btn subtle", onclick: clearPad }, "Cancella")),
      h("div", { class: "sign-pane", "data-pane": "scrivi" }, typed,
        h("canvas", { class: "sign-preview", width: 1200, height: 300 })),
      h("div", { class: "sign-pane", "data-pane": "foto" },
        h("p", { class: "sign-hint" }, "Una foto della firma su un foglio bianco: lo sfondo viene tolto da solo."),
        h("button", { type: "button", class: "btn", onclick: () => file.click() }, icon("open"), h("span", null, "Scegli la foto")),
        h("canvas", { class: "sign-preview photo", width: 1200, height: 400 }))),
    h("div", { class: "sign-options" },
      h("span", { class: "sign-colors" }, "Colore:",
        Object.entries(INK).map(([name, color]) => h("button", {
          type: "button", class: "sign-color", title: name, "aria-label": `Inchiostro ${name}`, style: `--ink:${color}`,
          onclick: () => { ink = color; markInk(); redrawTyped(); redrawPhoto(); },
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
    pad.setPointerCapture(e.pointerId);
    last = point(e);
    strokes++;
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

  typed.addEventListener("input", redrawTyped);
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    file.value = "";
    if (!f) return;
    try {
      photo = await createImageBitmap(f);
    } catch {
      photo = null;
    }
    redrawPhoto();
  });
  markInk();
}

function refreshSaved() {
  const s = saved();
  dialog.querySelector('[data-mode="salvata"]').hidden = !s;
  if (s) dialog.querySelector(".sign-saved").src = s;
}

function setMode(k) {
  mode = k;
  for (const t of dialog.querySelectorAll(".sign-tab")) t.setAttribute("aria-selected", String(t.dataset.mode === k));
  for (const p of dialog.querySelectorAll(".sign-pane")) p.hidden = p.dataset.pane !== k;
  if (k === "scrivi") dialog.querySelector(".sign-typed").focus();
}

function markInk() {
  for (const b of dialog.querySelectorAll(".sign-color")) b.setAttribute("aria-pressed", String(b.style.getPropertyValue("--ink") === ink));
}

function clearPad() {
  pad.getContext("2d").clearRect(0, 0, pad.width, pad.height);
  strokes = 0;
}

function redrawTyped() {
  const c = dialog.querySelector('[data-pane="scrivi"] canvas');
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  const text = dialog.querySelector(".sign-typed").value.trim();
  if (!text) return;
  let size = 150;
  do {
    ctx.font = `${size}px ${SCRIPT_FONTS}`;
    size -= 6;
  } while (ctx.measureText(text).width > c.width - 40 && size > 30);
  ctx.fillStyle = ink;
  ctx.textBaseline = "middle";
  ctx.fillText(text, 20, c.height / 2);
}

// Foto: i pixel chiari diventano trasparenti, quelli scuri prendono il colore dell'inchiostro.
function redrawPhoto() {
  const c = dialog.querySelector('[data-pane="foto"] canvas');
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, c.width, c.height);
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

// La firma del pannello attivo, ritagliata attorno al tratto.
async function currentSignature() {
  if (mode === "salvata") return saved();
  const c = mode === "disegna" ? pad : dialog.querySelector(`[data-pane="${mode}"] canvas`);
  if (mode === "disegna" && !strokes) return null;
  const cropped = crop(c);
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
