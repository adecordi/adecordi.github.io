// Vista leggibile delle fatture elettroniche (FatturaPA ordinaria e semplificata).
// Viene caricata solo quando si apre una fattura.
import { h, icon } from "./dom.js";

const TIPI_DOCUMENTO = {
  TD01: "Fattura",
  TD02: "Acconto/anticipo su fattura",
  TD03: "Acconto/anticipo su parcella",
  TD04: "Nota di credito",
  TD05: "Nota di debito",
  TD06: "Parcella",
  TD07: "Fattura semplificata",
  TD08: "Nota di credito semplificata",
  TD09: "Nota di debito semplificata",
  TD16: "Integrazione fattura reverse charge interno",
  TD17: "Integrazione/autofattura per acquisto servizi dall'estero",
  TD18: "Integrazione per acquisto di beni intracomunitari",
  TD19: "Integrazione/autofattura per acquisto di beni ex art. 17 c. 2 DPR 633/72",
  TD20: "Autofattura per regolarizzazione e integrazione delle fatture",
  TD21: "Autofattura per splafonamento",
  TD22: "Estrazione beni da Deposito IVA",
  TD23: "Estrazione beni da Deposito IVA con versamento dell'IVA",
  TD24: "Fattura differita (art. 21, c. 4, lett. a)",
  TD25: "Fattura differita (art. 21, c. 4, terzo periodo, lett. b)",
  TD26: "Cessione di beni ammortizzabili e passaggi interni",
  TD27: "Fattura per autoconsumo o cessioni gratuite senza rivalsa",
  TD28: "Acquisti da San Marino con IVA (fattura cartacea)",
  TD29: "Comunicazione per omessa o irregolare fatturazione",
};

const NATURE = {
  N1: "Escluse ex art. 15",
  N2: "Non soggette",
  "N2.1": "Non soggette (artt. da 7 a 7-septies DPR 633/72)",
  "N2.2": "Non soggette – altri casi",
  N3: "Non imponibili",
  "N3.1": "Non imponibili – esportazioni",
  "N3.2": "Non imponibili – cessioni intracomunitarie",
  "N3.3": "Non imponibili – cessioni verso San Marino",
  "N3.4": "Non imponibili – operazioni assimilate alle esportazioni",
  "N3.5": "Non imponibili – dichiarazioni d'intento",
  "N3.6": "Non imponibili – altre operazioni",
  N4: "Esenti",
  N5: "Regime del margine / IVA non esposta",
  N6: "Inversione contabile",
  "N6.1": "Inversione contabile – rottami e materiali di recupero",
  "N6.2": "Inversione contabile – oro e argento",
  "N6.3": "Inversione contabile – subappalto nel settore edile",
  "N6.4": "Inversione contabile – cessione di fabbricati",
  "N6.5": "Inversione contabile – telefoni cellulari",
  "N6.6": "Inversione contabile – prodotti elettronici",
  "N6.7": "Inversione contabile – comparto edile e settori connessi",
  "N6.8": "Inversione contabile – settore energetico",
  "N6.9": "Inversione contabile – altri casi",
  N7: "IVA assolta in altro Stato UE",
};

const MODALITA_PAGAMENTO = {
  MP01: "Contanti", MP02: "Assegno", MP03: "Assegno circolare", MP04: "Contanti presso Tesoreria",
  MP05: "Bonifico", MP06: "Vaglia cambiario", MP07: "Bollettino bancario", MP08: "Carta di pagamento",
  MP09: "RID", MP10: "RID utenze", MP11: "RID veloce", MP12: "RIBA", MP13: "MAV",
  MP14: "Quietanza erario", MP15: "Giroconto su conti di contabilità speciale", MP16: "Domiciliazione bancaria",
  MP17: "Domiciliazione postale", MP18: "Bollettino di c/c postale", MP19: "SEPA Direct Debit",
  MP20: "SEPA Direct Debit CORE", MP21: "SEPA Direct Debit B2B", MP22: "Trattenuta su somme già riscosse",
  MP23: "PagoPA",
};

const CONDIZIONI_PAGAMENTO = { TP01: "Pagamento a rate", TP02: "Pagamento completo", TP03: "Anticipo" };

const REGIMI_FISCALI = {
  RF01: "Ordinario", RF02: "Contribuenti minimi", RF04: "Agricoltura e pesca", RF05: "Vendita sali e tabacchi",
  RF06: "Commercio fiammiferi", RF07: "Editoria", RF08: "Gestione servizi telefonia pubblica",
  RF09: "Rivendita documenti di trasporto pubblico e di sosta", RF10: "Intrattenimenti e giochi",
  RF11: "Agenzie viaggi e turismo", RF12: "Agriturismo", RF13: "Vendite a domicilio",
  RF14: "Rivendita beni usati, oggetti d'arte e da collezione", RF15: "Agenzie di vendite all'asta",
  RF16: "IVA per cassa P.A.", RF17: "IVA per cassa", RF18: "Altro", RF19: "Regime forfettario",
  RF20: "Franchigia IVA transfrontaliera",
};

const ESIGIBILITA_IVA = { I: "Immediata", D: "Differita", S: "Scissione dei pagamenti" };

const TIPI_RITENUTA = {
  RT01: "Ritenuta persone fisiche", RT02: "Ritenuta persone giuridiche", RT03: "Contributo INPS",
  RT04: "Contributo ENASARCO", RT05: "Contributo ENPAM", RT06: "Altro contributo previdenziale",
};

const TIPI_CESSIONE = { SC: "Sconto", PR: "Premio", AB: "Abbuono", AC: "Spesa accessoria" };

const RIFERIMENTI = [
  ["DatiOrdineAcquisto", "Ordine d'acquisto"],
  ["DatiContratto", "Contratto"],
  ["DatiConvenzione", "Convenzione"],
  ["DatiRicezione", "Ricezione"],
  ["DatiFattureCollegate", "Fattura collegata"],
];

/* ---------------------------------------------------------- Lettura XML */

// I nodi della fattura non hanno namespace (tranne la radice): si cerca per nome locale.
const kids = (el, name) => (el ? Array.prototype.filter.call(el.children, (c) => c.localName === name) : []);
const kid = (el, name) => (el ? Array.prototype.find.call(el.children, (c) => c.localName === name) || null : null);
const at = (el, ...path) => path.reduce((e, name) => kid(e, name), el);
const txt = (el, ...path) => {
  const e = at(el, ...path);
  return e ? e.textContent.trim() : "";
};

/* --------------------------------------------------------- Formattazione */

// "always": separatore delle migliaia anche sotto 10.000 (1.342,00), come nelle fatture.
const numberFmt = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 8, useGrouping: "always" });
const num = (v) => (v === "" || !isFinite(+v) ? v : numberFmt.format(+v));
const pct = (v) => (v === "" ? "" : `${num(v)}%`);
const date = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
};
const label = (table, code) => (!code ? "" : table[code] ? `${table[code]} (${code})` : code);

function moneyFormat(currency) {
  let fmt = null;
  try {
    fmt = new Intl.NumberFormat("it-IT", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 8, useGrouping: "always" });
  } catch {
    // Codice valuta non riconosciuto: si mostra il numero seguito dal codice.
  }
  return (v) => {
    if (v === "" || v == null) return "";
    const n = +v;
    if (!isFinite(n)) return String(v);
    return fmt ? fmt.format(n) : `${numberFmt.format(n)} ${currency}`;
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
const sum = (els, name) => round2(els.reduce((acc, el) => acc + (+txt(el, name) || 0), 0));

/* ------------------------------------------------------------ Blocchi */

function facts(rows) {
  const items = rows.filter(([, v]) => v);
  if (!items.length) return null;
  return h("dl", { class: "inv-facts" }, items.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
}

function section(title, ...content) {
  const body = content.flat().filter(Boolean);
  if (!body.length) return null;
  return h("section", { class: "inv-section" }, h("h3", null, title), body);
}

function address(sede) {
  if (!sede) return "";
  const prov = txt(sede, "Provincia");
  const nazione = txt(sede, "Nazione");
  return [
    [txt(sede, "Indirizzo"), txt(sede, "NumeroCivico")].filter(Boolean).join(", "),
    [txt(sede, "CAP"), txt(sede, "Comune") + (prov ? ` (${prov})` : "")].filter(Boolean).join(" "),
    nazione && nazione !== "IT" ? nazione : "",
  ].filter(Boolean).join(" – ");
}

function party(title, el, extra = []) {
  if (!el) return null;
  const anagrafici = at(el, "DatiAnagrafici");
  const anagrafica = at(anagrafici, "Anagrafica") || at(el, "AltriDatiIdentificativi") || el;
  const name =
    txt(anagrafica, "Denominazione") ||
    [txt(anagrafica, "Titolo"), txt(anagrafica, "Nome"), txt(anagrafica, "Cognome")].filter(Boolean).join(" ");
  const ids = anagrafici || at(el, "IdentificativiFiscali") || el;
  const iva = at(ids, "IdFiscaleIVA");
  const rea = at(el, "IscrizioneREA");
  const contatti = at(el, "Contatti");
  return h("section", { class: "inv-party" },
    h("h3", null, title),
    h("p", { class: "inv-party-name" }, name || "—"),
    facts([
      ["Partita IVA", iva ? `${txt(iva, "IdPaese")} ${txt(iva, "IdCodice")}` : ""],
      ["Codice fiscale", txt(ids, "CodiceFiscale")],
      ["Indirizzo", address(at(el, "Sede") || at(el, "AltriDatiIdentificativi", "Sede"))],
      ["Regime fiscale", label(REGIMI_FISCALI, txt(anagrafici, "RegimeFiscale") || txt(el, "RegimeFiscale"))],
      ["REA", rea ? [txt(rea, "Ufficio"), txt(rea, "NumeroREA")].filter(Boolean).join(" ") : ""],
      ["Telefono", txt(contatti, "Telefono")],
      ["Email", txt(contatti, "Email")],
      ["Rif. amministrazione", txt(el, "RiferimentoAmministrazione")],
      ...extra,
    ]));
}

function headline(dg, total, money) {
  return h("header", { class: "inv-head" },
    h("div", null,
      h("p", { class: "inv-kind" }, label(TIPI_DOCUMENTO, txt(dg, "TipoDocumento")) || "Fattura elettronica"),
      h("h2", null, `N. ${txt(dg, "Numero") || "—"} del ${date(txt(dg, "Data")) || "—"}`)),
    h("div", { class: "inv-total" }, h("span", null, "Totale documento"), h("strong", null, money(total) || "—")));
}

function table(headers, rows, numericColumns) {
  if (!rows.length) return null;
  const cls = (i) => (numericColumns.includes(i) ? "num" : null);
  return h("div", { class: "inv-table-wrap" },
    h("table", { class: "inv-table" },
      h("thead", null, h("tr", null, headers.map((t, i) => h("th", { class: cls(i) }, t)))),
      h("tbody", null, rows.map((cells) => h("tr", null, cells.map((c, i) => h("td", { class: cls(i) }, c)))))));
}

function totals(rows) {
  return h("div", { class: "inv-totals" },
    rows.filter(([, v]) => v !== "").map(([k, v, grand]) =>
      h("div", { class: grand ? "grand" : null }, h("span", null, k), h("span", null, v))));
}

/* -------------------------------------------------- Fattura ordinaria */

function lineDetails(line) {
  const extras = [];
  for (const c of kids(line, "CodiceArticolo")) extras.push(`${txt(c, "CodiceTipo")}: ${txt(c, "CodiceValore")}`);
  const start = txt(line, "DataInizioPeriodo");
  const end = txt(line, "DataFinePeriodo");
  if (start || end) extras.push(`Periodo: ${date(start) || "…"} – ${date(end) || "…"}`);
  const tipo = txt(line, "TipoCessionePrestazione");
  if (tipo) extras.push(TIPI_CESSIONE[tipo] || tipo);
  if (txt(line, "RiferimentoAmministrazione")) extras.push(`Rif. amministrazione: ${txt(line, "RiferimentoAmministrazione")}`);
  for (const a of kids(line, "AltriDatiGestionali")) {
    const value = [txt(a, "RiferimentoTesto"), txt(a, "RiferimentoNumero") && num(txt(a, "RiferimentoNumero")), date(txt(a, "RiferimentoData"))]
      .filter(Boolean).join(" ");
    extras.push(`${txt(a, "TipoDato")}${value ? `: ${value}` : ""}`);
  }
  return extras;
}

function discounts(el, money) {
  return kids(el, "ScontoMaggiorazione").map((s) => {
    const sign = txt(s, "Tipo") === "MG" ? "+" : "−";
    return txt(s, "Percentuale") ? `${sign}${pct(txt(s, "Percentuale"))}` : `${sign}${money(txt(s, "Importo"))}`;
  }).join(" ");
}

function vatCell(el) {
  const rate = txt(el, "AliquotaIVA");
  return +rate === 0 && txt(el, "Natura") ? txt(el, "Natura") : pct(rate);
}

function ordinaria(body) {
  const dg = at(body, "DatiGenerali", "DatiGeneraliDocumento");
  const money = moneyFormat(txt(dg, "Divisa") || "EUR");
  const beni = at(body, "DatiBeniServizi");
  const riepiloghi = kids(beni, "DatiRiepilogo");
  const imponibile = sum(riepiloghi, "ImponibileImporto");
  const imposta = sum(riepiloghi, "Imposta");
  const declaredTotal = txt(dg, "ImportoTotaleDocumento");
  const total = declaredTotal !== "" ? +declaredTotal : riepiloghi.length ? round2(imponibile + imposta) : "";
  const ritenute = kids(dg, "DatiRitenuta");
  const pagamenti = kids(body, "DatiPagamento");
  const rate = pagamenti.flatMap((p) => kids(p, "DettaglioPagamento"));

  const generali = at(body, "DatiGenerali");
  const general = facts([
    ["Causale", kids(dg, "Causale").map((c) => c.textContent.trim()).join(" ")],
    ["Valuta", txt(dg, "Divisa") !== "EUR" ? txt(dg, "Divisa") : ""],
    ["Bollo", at(dg, "DatiBollo") ? `${txt(dg, "DatiBollo", "BolloVirtuale") === "SI" ? "virtuale " : ""}${money(txt(dg, "DatiBollo", "ImportoBollo"))}` : ""],
    ...ritenute.map((r) => [label(TIPI_RITENUTA, txt(r, "TipoRitenuta")) || "Ritenuta",
      `${money(txt(r, "ImportoRitenuta"))} (${pct(txt(r, "AliquotaRitenuta"))})${txt(r, "CausalePagamento") ? ` – causale ${txt(r, "CausalePagamento")}` : ""}`]),
    ...kids(dg, "DatiCassaPrevidenziale").map((c) => ["Cassa previdenziale",
      `${txt(c, "TipoCassa")} ${pct(txt(c, "AlCassa"))}: ${money(txt(c, "ImportoContributoCassa"))}${txt(c, "Ritenuta") === "SI" ? " (soggetto a ritenuta)" : ""}`]),
    ["Sconti/maggiorazioni", discounts(dg, money)],
    ["Arrotondamento", money(txt(dg, "Arrotondamento"))],
    ["Art. 73", txt(dg, "Art73") === "SI" ? "Sì" : ""],
    ...RIFERIMENTI.flatMap(([tag, name]) => kids(generali, tag).map((r) => [name,
      [txt(r, "IdDocumento"), txt(r, "Data") && `del ${date(txt(r, "Data"))}`, txt(r, "CodiceCIG") && `CIG ${txt(r, "CodiceCIG")}`,
        txt(r, "CodiceCUP") && `CUP ${txt(r, "CodiceCUP")}`, txt(r, "CodiceCommessaConvenzione") && `commessa ${txt(r, "CodiceCommessaConvenzione")}`]
        .filter(Boolean).join(" ")])),
    ...kids(generali, "DatiDDT").map((d) => ["DDT", `n. ${txt(d, "NumeroDDT")} del ${date(txt(d, "DataDDT"))}`]),
  ]);

  const lines = kids(beni, "DettaglioLinee").map((l) => [
    txt(l, "NumeroLinea"),
    h("span", null, txt(l, "Descrizione"), lineDetails(l).map((e) => h("span", { class: "inv-extra" }, e))),
    txt(l, "Quantita") ? `${num(txt(l, "Quantita"))}${txt(l, "UnitaMisura") ? ` ${txt(l, "UnitaMisura")}` : ""}` : "",
    money(txt(l, "PrezzoUnitario")),
    discounts(l, money),
    money(txt(l, "PrezzoTotale")),
    vatCell(l) + (txt(l, "Ritenuta") === "SI" ? " · rit." : ""),
  ]);

  const vatRows = riepiloghi.map((r) => [
    +txt(r, "AliquotaIVA") === 0 && txt(r, "Natura") ? label(NATURE, txt(r, "Natura")) : pct(txt(r, "AliquotaIVA")),
    money(txt(r, "ImponibileImporto")),
    money(txt(r, "Imposta")),
    ESIGIBILITA_IVA[txt(r, "EsigibilitaIVA")] || txt(r, "EsigibilitaIVA"),
    txt(r, "RiferimentoNormativo"),
  ]);

  const toPay = rate.length ? sum(rate, "ImportoPagamento") : "";
  const payments = pagamenti.map((p) => h("div", { class: "inv-payment" },
    h("p", { class: "inv-payment-title" }, label(CONDIZIONI_PAGAMENTO, txt(p, "CondizioniPagamento"))),
    kids(p, "DettaglioPagamento").map((d) => facts([
      ["Modalità", label(MODALITA_PAGAMENTO, txt(d, "ModalitaPagamento"))],
      ["Importo", money(txt(d, "ImportoPagamento"))],
      ["Scadenza", date(txt(d, "DataScadenzaPagamento"))],
      ["Beneficiario", txt(d, "Beneficiario")],
      ["IBAN", txt(d, "IBAN")],
      ["Istituto", txt(d, "IstitutoFinanziario")],
      ["BIC", txt(d, "BIC")],
      ["Codice pagamento", txt(d, "CodicePagamento")],
    ]))));

  return {
    head: headline(dg, total, money),
    content: [
      section("Dati del documento", general),
      section("Dettaglio", table(["N.", "Descrizione", "Quantità", "Prezzo unitario", "Sconti", "Importo", "IVA"], lines, [2, 3, 5])),
      section("Riepilogo IVA", table(["Aliquota / natura", "Imponibile", "Imposta", "Esigibilità", "Riferimento normativo"], vatRows, [1, 2])),
      totals([
        ["Imponibile", riepiloghi.length ? money(imponibile) : ""],
        ["IVA", riepiloghi.length ? money(imposta) : ""],
        ...ritenute.map((r) => [label(TIPI_RITENUTA, txt(r, "TipoRitenuta")) || "Ritenuta", money(-(+txt(r, "ImportoRitenuta") || 0))]),
        ["Totale documento", money(total), true],
        ...(toPay !== "" && total !== "" && toPay !== total ? [["Netto a pagare", money(toPay), true]] : []),
      ]),
      section("Pagamento", payments),
    ],
  };
}

/* ------------------------------------------------ Fattura semplificata */

function semplificata(body) {
  const dg = at(body, "DatiGenerali", "DatiGeneraliDocumento");
  const money = moneyFormat(txt(dg, "Divisa") || "EUR");
  const beni = kids(body, "DatiBeniServizi");
  const total = sum(beni, "Importo");
  const rettificata = at(body, "DatiGenerali", "DatiFatturaRettificata");
  const lines = beni.map((b) => [
    txt(b, "Descrizione"),
    money(txt(b, "Importo")),
    txt(b, "Natura") ? label(NATURE, txt(b, "Natura")) : [pct(txt(b, "DatiIVA", "Aliquota")), money(txt(b, "DatiIVA", "Imposta"))].filter(Boolean).join(" – "),
  ]);
  return {
    head: headline(dg, total, money),
    content: [
      section("Dati del documento", facts([
        ["Rettifica della fattura", rettificata ? `n. ${txt(rettificata, "NumeroFR")} del ${date(txt(rettificata, "DataFR"))}` : ""],
      ])),
      section("Dettaglio", table(["Descrizione", "Importo (IVA inclusa)", "IVA"], lines, [1])),
      totals([["Totale documento", money(total), true]]),
    ],
  };
}

/* ------------------------------------------------------------ Allegati */

function decodeBase64(node) {
  const s = atob(node.textContent.replace(/[^A-Za-z0-9+/=]/g, ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function sizeLabel(bytes) {
  return bytes > 1048576 ? `${num((bytes / 1048576).toFixed(1))} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function attachments(body, actions) {
  const list = kids(body, "Allegati");
  if (!list.length) return null;
  return section(`Allegati (${list.length})`, list.map((a) => {
    const node = at(a, "Attachment");
    const format = txt(a, "FormatoAttachment").toLowerCase();
    let name = txt(a, "NomeAttachment") || "allegato";
    if (format && !/\.[A-Za-z0-9]{1,5}$/.test(name)) name += `.${format}`;
    const size = node ? Math.floor((node.textContent.replace(/\s/g, "").length * 3) / 4) : 0;
    const bytes = () => decodeBase64(node);
    return h("div", { class: "inv-attachment" },
      icon("file"),
      h("div", { class: "inv-attachment-main" },
        h("strong", null, name),
        h("span", null, [txt(a, "DescrizioneAttachment"), size ? sizeLabel(size) : ""].filter(Boolean).join(" · "))),
      node && h("div", { class: "inv-attachment-actions" },
        h("button", { class: "btn", type: "button", onclick: () => actions.open(bytes(), name) }, "Apri"),
        h("button", { class: "btn", type: "button", onclick: () => actions.save(bytes(), name) }, icon("download"), "Salva")));
  }));
}

/* ------------------------------------------------------------ Ingresso */

export function isFattura(root) {
  return !!root && /^FatturaElettronica(Semplificata)?$/.test(root.localName);
}

/**
 * @param {Element} root radice del documento XML
 * @param {{ open: (bytes: Uint8Array, name: string) => void, save: (bytes: Uint8Array, name: string) => void }} actions
 */
export function renderFattura(root, actions) {
  const renderBody = root.localName === "FatturaElettronicaSemplificata" ? semplificata : ordinaria;
  const header = at(root, "FatturaElettronicaHeader");
  const trasmissione = at(header, "DatiTrasmissione");
  const parties = h("div", { class: "inv-parties" },
    party("Cedente / prestatore", at(header, "CedentePrestatore")),
    party("Cessionario / committente", at(header, "CessionarioCommittente"), [
      ["Codice destinatario", txt(trasmissione, "CodiceDestinatario") !== "0000000" ? txt(trasmissione, "CodiceDestinatario") : ""],
      ["PEC destinatario", txt(trasmissione, "PECDestinatario")],
    ]));
  const others = [
    party("Rappresentante fiscale", at(header, "RappresentanteFiscale")),
    party("Terzo intermediario / soggetto emittente", at(header, "TerzoIntermediarioOSoggettoEmittente")),
  ].filter(Boolean);

  const bodies = kids(root, "FatturaElettronicaBody");
  const out = h("div", { class: "invoice" });
  bodies.forEach((body, i) => {
    const { head, content } = renderBody(body);
    const article = h("article", { class: "inv-body" },
      bodies.length > 1 && h("p", { class: "inv-lot" }, `Documento ${i + 1} di ${bodies.length}`),
      head,
      i === 0 && [parties, others],
      content,
      attachments(body, actions));
    out.append(article);
  });
  if (!bodies.length) out.append(parties, ...others);
  const formato = txt(trasmissione, "FormatoTrasmissione");
  if (formato) {
    out.append(h("p", { class: "inv-footnote" },
      `Formato ${formato}${formato === "FPA12" ? " (fattura verso la Pubblica Amministrazione)" : ""}` +
        (txt(trasmissione, "ProgressivoInvio") ? ` · progressivo invio ${txt(trasmissione, "ProgressivoInvio")}` : "")));
  }
  return out;
}
