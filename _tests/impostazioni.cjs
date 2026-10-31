// «Impostazioni» (31/10/2026): avvertenze, compilatore, chi compila e la scelta della cassaforte.
const { chromium } = require("playwright");
const { FX, BASE, check, watchErrors } = require("./common.cjs");

const FAKE = "https://compilatore.prova";

(async () => {
  const b = await chromium.launch();
  const apriCon = async (extra) => {
    const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    watchErrors(page, errors);
    await page.route(FAKE + "/**", (route) => route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } }));
    await page.goto(BASE + "#compilatore=" + encodeURIComponent(FAKE) + "&chiave=prova" + extra);
    return { page, errors };
  };

  let { page, errors } = await apriCon("");
  check("l'ingranaggio c'è anche nella pagina iniziale", await page.isVisible("#btnImpostazioni"));
  await page.click("#btnImpostazioni");
  await page.waitForSelector(".imp-dialog[open]");
  const testo = await page.textContent(".imp-dialog");
  check("sezioni: cassaforte, compilatore, chi compila, avvertenze",
    ["Cassaforte dei dati", "Compilatore", "Chi compila", "Avvertenze"].every((t) => testo.includes(t)));
  check("compilatore collegato, con l'indirizzo", testo.includes("compilatore.prova"));
  check("avvertenze: AI, firma grafica, p7m", testo.includes("L'AI può sbagliare") && testo.includes("Firma grafica") && testo.includes(".p7m"));
  await page.check(".imp-dialog input[name=impCf][value=vm]");
  await page.fill(".imp-dialog .fill-chi", "Mario Prova");
  await page.locator(".imp-dialog .fill-chi").press("Tab");
  await page.click(".imp-dialog .btn.primary");
  // con la cassaforte del server, «Compila» va dritto alle istruzioni
  await page.setInputFiles("#fileInput", FX + "doc.pdf");
  await page.waitForSelector("#btnFill:not([hidden])");
  await page.click("#btnFill");
  await page.waitForSelector(".fill-dialog[open]", { timeout: 5000 });
  check("cassaforte del server: niente accesso alla cassaforte aziendale", !(await page.isVisible(".cf-dialog")));
  check("«Chi compila» preso dalle impostazioni", (await page.inputValue("#fillChi")) === "Mario Prova");
  check("nessun errore nella pagina", errors.length === 0, errors.join(" | "));
  await page.close();

  ({ page, errors } = await apriCon("&solo=collega"));
  await page.click("#btnImpostazioni");
  await page.waitForSelector(".imp-dialog[open]");
  check("per un collega la cassaforte del server non si può scegliere",
    await page.isDisabled(".imp-dialog input[name=impCf][value=vm]") && await page.isChecked(".imp-dialog input[name=impCf][value=aziendale]"));
  await page.close();
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
