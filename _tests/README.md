# Test del Lettore PDF e P7M

Test end-to-end con Playwright (Chromium). La cartella inizia con `_`, quindi GitHub Pages non la pubblica.

## Requisiti
- Node.js 18 o più recente
- Python 3 con `pip install reportlab pypdf cryptography pillow`
- OpenSSL e Bash. Su Windows vanno bene quelli di Git for Windows: esegui i comandi da **Git Bash**.
- Facoltativo: ImageMagick, per il test delle immagini JPEG 2000

## Uso
```bash
cd _tests
npm install
npx playwright install chromium
npm test                 # genera i file di prova se mancano, avvia il server e lancia tutti i test
node run.cjs outlook     # un solo test (anche: e2e, mobile, condividi, ricezione, link, stampa, jpx, unwrap)
npm run fixtures         # rigenera i file di prova in fixtures/out
npm run server           # solo il lettore su http://127.0.0.1:8766/pdf/
npm run perf             # misure di prestazioni (rete 4G e CPU rallentate)
```

Ogni controllo stampa `✔` o `✘`. Screenshot e PDF di stampa finiscono in `shots/`.

I file di prova usano certificati di una CA finta, generati da `fixtures/genera.sh`; le chiavi restano solo in `fixtures/out` (escluso da git). Outlook è simulato: `outlook.cjs` sostituisce `office.js` con un finto Outlook che ha un messaggio normale e una PEC.
