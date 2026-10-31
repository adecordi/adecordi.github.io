// Filtro di lettura (31/10/2026): «Notte» inverte l'immagine della pagina, «Seppia» la scalda. È solo CSS su
// body[data-filtro] (vedi style.css): non tocca il testo, le note né la stampa. Si ricorda in localStorage e si
// applica all'avvio, prima che compaia il documento.
import { h } from "./dom.js";

const CHIAVE = "lettore-filtro";
const MODI = [
  ["", "Colori normali", "il documento com'è"],
  ["notte", "Notte", "per leggere al buio"],
  ["seppia", "Seppia", "toni caldi, meno abbagliante"],
];

export function filtro() {
  return document.body.dataset.filtro || "";
}

export function applica(modo) {
  if (!MODI.some(([m]) => m === modo)) modo = "";
  if (modo) document.body.dataset.filtro = modo;
  else delete document.body.dataset.filtro;
  try {
    if (modo) localStorage.setItem(CHIAVE, modo);
    else localStorage.removeItem(CHIAVE);
  } catch {
    // niente memoria (navigazione privata, spazio pieno): il filtro vale solo per questa volta
  }
  for (const b of document.querySelectorAll("#menuAltro [data-filtro]")) b.setAttribute("aria-checked", String(b.dataset.filtro === modo));
}

// All'avvio: il filtro dell'ultima volta.
export function avvia() {
  let salvato = "";
  try {
    salvato = localStorage.getItem(CHIAVE) || "";
  } catch {
    // come sopra
  }
  applica(salvato);
}

// Le voci nel menu «Altro»; `chiudi` è del menu, che le voci chiudono dopo la scelta.
export function vociMenu(menu, chiudi) {
  menu.append(...MODI.map(([modo, titolo, sotto]) =>
    h("button", { class: "share-option", type: "button", role: "menuitemradio", "data-filtro": modo,
      "aria-checked": String(filtro() === modo), onclick: () => { chiudi(); applica(modo); } },
      h("strong", null, titolo), h("span", null, sotto))));
}
