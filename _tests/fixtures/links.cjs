// PDF con link lunghi che vanno a capo dentro un riquadro (generato da Chrome).
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  await p.setContent(`<html><body style="font-family: sans-serif; font-size: 15pt; margin: 40px; line-height: 1.5">
  <p>Paragrafo introduttivo di prova con del testo normale prima del riquadro.</p>
  <div style="border: 1.5px solid #3b6aa0; border-radius: 6px; padding: 10px 16px; width: 640px">
    <div style="color:#2b5a8a; font-weight:bold">Scheda metodologica e trasparenza AI</div>
    Fonti, metodo, limiti dell’AI, legenda dei simboli e metriche di lavoro: si scarica qui
    <a href="https://relazioni.example.it/e3ivO1CqY5km/il-commercialista-per-il-giudice/scheda.pdf">https://relazioni.example.it/e3ivO1CqY5km/il-commercialista-per-il-giudice/scheda.pdf</a>
    Controllo delle citazioni di leggi e sentenze sulle fonti ufficiali (10/2026): <a href="https://relazioni.example.it/e3ivO1CqY5km/il-commercialista-per-il-giudice/citazioni.pdf">https://relazioni.example.it/e3ivO1CqY5km/il-commercialista-per-il-giudice/citazioni.pdf</a>
  </div></body></html>`);
  await p.pdf({ path: "link_chrome.pdf", format: "A4" });
  await b.close();
})();
