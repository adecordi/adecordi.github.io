// «Impostazioni» (Alessandro, 31/10/2026): la cassaforte dei dati per i moduli, il compilatore, chi compila, e le
// avvertenze (dove vanno i dati, cosa fa l'AI, cosa non garantiscono firme e verifiche).
import { h, icon } from "./dom.js";
import * as compila from "./compila.js";
import * as cassaforte from "./cassaforte.js";

let dlg = null;

const avvertenze = [
  ["Dove vanno i tuoi file", "I documenti si aprono e si leggono su questo dispositivo: non vanno su nessun server. Solo le " +
    "funzioni con l'AI (Compila, Riassumi, Traduci, Sottolinea, Spiega, OCR sul server) mandano il testo o la pagina al " +
    "compilatore della Vinicola, e solo quando le premi. Il compilatore usa l'AI Claude di Anthropic."],
  ["Cosa resta e dove", "La bozza dell'ultimo documento modificato resta solo in questo browser finché non lo salvi. Il " +
    "compilatore ricorda per 30 giorni i moduli compilati (per rifarli subito uguali) e scrive un registro senza i dati."],
  ["L'AI può sbagliare", "Dati compilati, riassunti, traduzioni, spiegazioni e punti sottolineati sono scritti dall'AI: " +
    "controllali sempre sul documento prima di usarli o mandarli. Le dichiarazioni le fa chi firma: C.A.R.T.A. le prepara soltanto. " +
    "Una traduzione dell'AI non è una traduzione ufficiale."],
  ["Firma grafica e firma digitale", "La firma che metti con C.A.R.T.A. è un'immagine (firma grafica), non una firma " +
    "digitale: non ha il valore legale di una firma digitale o qualificata."],
  ["Verifica dei file firmati (.p7m)", "C.A.R.T.A. controlla l'integrità e la validità dei certificati alla data della " +
    "firma, non la revoca del certificato né l'affidabilità del certificatore: per una verifica con valore legale usa " +
    "un servizio ufficiale."],
  ["Dati nella cassaforte aziendale", "I tuoi dati per i moduli stanno nella tua raccolta della cassaforte aziendale: " +
    "li vedono anche gli amministratori (Alessandro e Giulia). La password non esce da questo dispositivo."],
];

async function disegna() {
  const cfg = compila.config();
  const collega = !!(cfg && cfg.collega);
  const scelta = collega ? "aziendale" : compila.sceltaCassaforte();
  const corpo = dlg.querySelector(".imp-corpo");
  const sezione = (titolo, ...dentro) => h("section", { class: "imp-sezione" }, h("h3", null, titolo), ...dentro);
  const statoCf = cassaforte.aperta()
    ? h("p", { class: "imp-stato" }, "✓ Sei dentro come ", h("strong", null, cassaforte.nomeUtente() || cassaforte.emailRicordata()),
      h("button", { class: "btn", type: "button", onclick: () => {
        cassaforte.esci();
        disegna();
      } }, "Esci"))
    : h("p", { class: "imp-stato" }, cassaforte.emailRicordata()
      ? `Non sei dentro (ultimo accesso: ${cassaforte.emailRicordata()}). Ti chiede la password al prossimo «Compila».`
      : "Non sei dentro: ti chiede e-mail e password al prossimo «Compila».");
  const opzione = (valore, titolo, descr, disattiva) => h("label", { class: "fill-who-opt" + (disattiva ? " imp-off" : "") },
    h("input", { type: "radio", name: "impCf", value: valore, checked: scelta === valore, disabled: disattiva,
      onchange: () => {
        compila.sceltaCassaforte(valore);
        disegna();
      } }),
    h("span", null, h("strong", null, titolo), h("small", null, descr)));
  let chi = "";
  try {
    chi = localStorage.getItem("lettore-chi-compila") || "";
  } catch { /* niente */ }
  corpo.replaceChildren(
    sezione("Cassaforte dei dati per i moduli",
      h("fieldset", { class: "fill-who" },
        opzione("aziendale", "Cassaforte aziendale", "cassaforte.it.fo, con le tue credenziali di Bitwarden (consigliata)", false),
        opzione("vm", "Cassaforte del server", collega ? "solo per Alessandro" : "i dati salvati sul server della Vinicola", collega)),
      scelta === "aziendale" ? statoCf : null,
      scelta === "aziendale" ? h("div", { class: "imp-azioni" },
        h("button", { class: "btn", type: "button", onclick: () => compila.apriMieiDati() }, "I miei dati")) : null),
    sezione("Compilatore",
      cfg
        ? h("p", { class: "imp-stato" }, "✓ Collegato a ", h("strong", null, new URL(cfg.url).host), collega ? " (con la tua chiave da collega)" : "",
          h("button", { class: "btn", type: "button", onclick: () => {
            if (!confirm("Scollego questo dispositivo dal compilatore? Per ricollegarlo servirà di nuovo il link.")) return;
            compila.unlink();
            location.reload();
          } }, "Scollega"))
        : h("p", { class: "imp-stato" }, "Non collegato: Compila, Riassumi, Traduci e le altre funzioni con l'AI non ci sono. " +
          "Per collegarlo apri il link che ti ha dato Alessandro.")),
    sezione("Chi compila",
      h("input", { class: "fill-chi", type: "text", value: chi, placeholder: "Nome e cognome", "aria-label": "Chi compila",
        onchange: (e) => {
          try {
            localStorage.setItem("lettore-chi-compila", e.target.value.trim());
          } catch { /* niente */ }
        } }),
      h("p", { class: "fill-hint" }, "Nei moduli dell'azienda è proposto come referente o persona di contatto.")),
    sezione("Avvertenze", ...avvertenze.map(([t, d]) => h("details", { class: "imp-avv" }, h("summary", null, t), h("p", null, d)))),
    h("p", { class: "imp-versione" }, document.getElementById("versione")?.textContent || ""));
}

/** La finestra delle impostazioni. */
export async function apri() {
  if (!dlg) {
    dlg = h("dialog", { class: "modal imp-dialog", "aria-labelledby": "impTitle" },
      h("form", { method: "dialog" },
        h("h2", { id: "impTitle" }, icon("settings"), " Impostazioni"),
        h("div", { class: "imp-corpo" }),
        h("div", { class: "modal-actions" }, h("button", { class: "btn primary", type: "submit", value: "ok" }, "Chiudi"))));
    document.body.append(dlg);
  }
  await disegna();
  dlg.showModal();
}
