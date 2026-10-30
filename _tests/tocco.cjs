// Firma col dito (iPad): si sposta trascinandola e si ridimensiona dagli angoli.
// Il dito è simulato con Input.dispatchTouchEvent: page.mouse non riproduce il problema del 29/10/2026.
const { chromium, devices } = require("playwright");
const { FX, BASE, check, watchErrors } = require("./common.cjs");

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices["iPad Pro 11"] });
  const page = await ctx.newPage();
  const errors = [];
  watchErrors(page, errors);
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
  const dragT = async (x0, y0, x1, y1) => {
    await touch("touchStart", x0, y0);
    for (let i = 1; i <= 12; i++) { await touch("touchMove", x0 + (x1 - x0) * i / 12, y0 + (y1 - y0) * i / 12); await page.waitForTimeout(16); }
    await touch("touchEnd");
  };
  await page.goto(BASE);
  await page.setInputFiles("#fileInput", FX + "doc.pdf");
  await page.waitForSelector(".page[data-page-number='1'] .textLayer span");
  await page.waitForTimeout(500);
  await page.tap("#btnSign");
  await page.waitForSelector(".sign-dialog[open]");
  check("firma: niente schede", (await page.$$(".sign-tab")).length === 0);
  await page.fill(".sign-dialog .sign-typed", "Mario Rossi");
  await page.tap(".sign-dialog .btn.primary");
  const st = await page.waitForSelector(".stampEditor", { timeout: 10000 });
  await page.waitForTimeout(800);
  const a = await st.boundingBox();
  await dragT(a.x + a.width / 2, a.y + a.height / 2, a.x + a.width / 2 + 120, a.y + a.height / 2 + 80);
  await page.waitForTimeout(400);
  const b2 = await st.boundingBox();
  check("col dito la firma si sposta", Math.abs(b2.x - a.x - 120) < 15 && Math.abs(b2.y - a.y - 80) < 15, `${Math.round(b2.x - a.x)}, ${Math.round(b2.y - a.y)}`);
  const r = await page.$(".stampEditor .resizer.bottomRight");
  const rb = await r.boundingBox();
  check("maniglie grandi abbastanza per il dito", rb.width >= 16, `${Math.round(rb.width)} px`);
  check("niente maniglie centrali che coprono la firma", await page.isHidden(".stampEditor .resizer.bottomMiddle"));
  await dragT(rb.x + rb.width / 2, rb.y + rb.height / 2, rb.x + 90, rb.y + 45);
  await page.waitForTimeout(400);
  const w = (await st.boundingBox()).width;
  check("col dito la firma si ridimensiona", w > b2.width + 40, `${Math.round(b2.width)} -> ${Math.round(w)} px`);

  // Toccare fuori non fissa la firma: la barra resta, e la firma si sposta ancora.
  const pg = await (await page.$(".page[data-page-number='1']")).boundingBox();
  await page.tap(".page[data-page-number='1']", { position: { x: 40, y: pg.height - 60 } });
  await page.waitForTimeout(300);
  check("toccando fuori la firma non si fissa", await page.isVisible("#signBar"));
  const c = await st.boundingBox();
  await dragT(c.x + c.width / 2, c.y + c.height / 2, c.x + c.width / 2 - 60, c.y + c.height / 2 + 40);
  await page.waitForTimeout(300);
  const d = await st.boundingBox();
  check("e si sposta ancora", Math.abs(d.x - c.x + 60) < 15, `${Math.round(d.x - c.x)}`);

  // Annulla e Ripeti
  check("Annulla attivo", await page.isEnabled("#btnUndo"));
  await page.tap("#btnUndo");
  await page.waitForTimeout(300);
  const e1 = await st.boundingBox();
  check("Annulla riporta la firma dov'era", Math.abs(e1.x - c.x) < 15, `${Math.round(e1.x - c.x)}`);
  check("Ripeti attivo", await page.isEnabled("#btnRedo"));
  await page.tap("#btnRedo");
  await page.waitForTimeout(300);
  const e2 = await st.boundingBox();
  check("Ripeti la rimette", Math.abs(e2.x - d.x) < 15, `${Math.round(e2.x - d.x)}`);

  // «Fatto» la fissa; toccandola si riprende
  await page.tap("#signDone");
  await page.waitForTimeout(300);
  check("«Fatto» chiude la barra", await page.isHidden("#signBar"));
  const f = await st.boundingBox();
  await page.tap(".page[data-page-number='1']", { position: { x: f.x - pg.x + f.width / 2, y: f.y - pg.y + f.height / 2 } });
  await page.waitForTimeout(500);
  check("toccando la firma fissata si riprende", await page.isVisible("#signBar"));
  await page.tap("#signDone");

  check("nessun errore nella pagina", errors.length === 0, errors.join(" | "));
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
