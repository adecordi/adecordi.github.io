# Contesto del progetto

Sito personale pubblicato con GitHub Pages dal ramo `main` (https://adecordi.github.io). Il progetto principale è il **Lettore PDF e P7M** in `pdf/`. Interfaccia, commenti e messaggi di commit sono in italiano.

## Lettore PDF e P7M (`pdf/`)
Web app statica, senza build: tutto avviene nel browser e i file non vengono mai inviati a un server.
- `index.html`, `style.css`: interfaccia (tema chiaro/scuro, layout per telefono).
- `app.js`: logica principale (apertura file, pannello firme, viste testo/XML/immagini, stampa, salvataggio, Condividi, PWA).
- `viewer.js`: tutto ciò che usa PDF.js. Si carica in background e avvia subito il worker. Contiene la stampa: nativa su Chrome/Edge desktop, altrimenti canvas o PNG codificati in `print-encoder.js`.
- `p7m.js`: parser ASN.1/CMS per `.p7m` (DER, BER, Base64, annidati), `.tsd`, `.m7m`. Verifica le firme con WebCrypto in parallelo; `unwrap()` è sincrona e restituisce `verification`.
- `fattura.js`: vista leggibile FatturaPA (ordinaria e semplificata), caricata solo quando serve.
- `outlook.js` e `outlook/`: componente aggiuntivo di Outlook. Il manifest XML punta a `https://adecordi.github.io/pdf/?outlook=1`; elenca gli allegati, anche dentro `postacert.eml` delle PEC.
- `sw.js`: service worker cache-first. **A ogni modifica dei file del lettore aggiorna `VERSION`**, altrimenti le app installate non si aggiornano.
- `lib/pdfjs/`: PDF.js 6.4.299, build legacy. `pdf_viewer.min.mjs` e `pdf_viewer.min.css` sono minificati con esbuild a partire da `pdfjs-dist`.

## Test
`cd _tests && npm install && npx playwright install chromium && npm test` (dettagli in `_tests/README.md`). Esegui i test prima di ogni push.

## Lavori aperti
1. Provare il componente aggiuntivo in un **Outlook reale**: installare `pdf/outlook/manifest.xml` da https://aka.ms/olksideload → Componenti aggiuntivi personali → Aggiungi da file. Controllare l'elenco degli allegati, una PEC, «Apri in una finestra grande», Stampa e Salva dentro il riquadro.
2. Verificare i link con il PDF reale dell'utente su https://relazioni.deco.it.fo/e3ivO1CqY5km/il-commercialista-per-il-giudice/. Il riquadro giallo dei link è stato tolto perché l'area del link nel PDF è sfasata rispetto al testo.
3. Scegliere un **nome e un logo** per il lettore. Ora si chiama «Lettore PDF e P7M» e il logo è `pdf/icons/icon.svg`, con le PNG generate da quel file. Il nome compare in `index.html`, `manifest.webmanifest`, `outlook/manifest.xml` e `outlook/index.html`.
