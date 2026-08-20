// ============================================================================
// LA GARA DELL'AI — motore dell'animazione (canvas 1920x1080, 60 s @ 30 fps)
// Timeline deterministica: ogni frame dipende solo dal numero di frame,
// così la pagina può essere registrata frame-per-frame in un MP4 identico.
// API esposte per il rendering: window.seekFrame(n), window.TOTAL_FRAMES
// ============================================================================
(function () {
  'use strict';

  const D = window.AIRACE_DATA;
  const W = 1920, H = 1080;
  const FPS = 30, DUR = 180;
  const TOTAL = FPS * DUR;

  const INTRO_END = 6.0;    // s: fine intro
  const RACE_HOLD = 158.0;  // s: il cursore temporale arriva a "oggi"
  const RACE_END  = 163.0;  // s: inizio transizione alla classifica
  const TAG_AT    = 174.5;  // s: comparsa della chiusura

  const FONT = '"Inter","Segoe UI",Arial,sans-serif';
  const EFONT = '"Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",sans-serif';
  const BG = '#0b0f1a';
  const GOLD = '#ffd166';
  const MESI = ['gennaio','febbraio','marzo','aprile','maggio','giugno',
                'luglio','agosto','settembre','ottobre','novembre','dicembre'];

  const DAY = 86400000;
  const RAMP = 30 * DAY; // giorni di "salita" morbida dopo ogni release

  function u(s) { const p = s.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }

  // --- pianificazione tempo-animazione -> tempo-dati (piecewise lineare) ---
  // Il tempo non scorre a velocità costante: ogni segmento è più lento del
  // precedente (da ~19 a ~4 giorni al secondo), così il finale si legge bene.
  const SCHED = [
    [INTRO_END, u('2022-11-30')],
    [15.5,  u('2023-06-01')],   // 19.3 giorni/s
    [29.5,  u('2024-01-01')],   // 15.3
    [48.5,  u('2024-09-01')],   // 12.8
    [63.0,  u('2025-01-25')],   // 10.1
    [86.0,  u('2025-08-01')],   //  8.1
    [110.5, u('2026-01-01')],   //  6.2
    [133.0, u('2026-05-01')],   //  5.3
    [RACE_HOLD, D.tEnd],        //  4.4
  ];

  function dataTime(sec) {
    if (sec <= SCHED[0][0]) return SCHED[0][1];
    for (let i = 1; i < SCHED.length; i++) {
      if (sec <= SCHED[i][0]) {
        const [s0, t0] = SCHED[i - 1], [s1, t1] = SCHED[i];
        return t0 + (t1 - t0) * (sec - s0) / (s1 - s0);
      }
    }
    return SCHED[SCHED.length - 1][1];
  }
  function animSecOf(t) {
    if (t <= SCHED[0][1]) return SCHED[0][0];
    for (let i = 1; i < SCHED.length; i++) {
      if (t <= SCHED[i][1]) {
        const [s0, t0] = SCHED[i - 1], [s1, t1] = SCHED[i];
        return s0 + (s1 - s0) * (t - t0) / (t1 - t0);
      }
    }
    return SCHED[SCHED.length - 1][0];
  }

  // --- preparazione dati ---
  const players = D.players.map(p => ({
    ...p,
    rel: p.releases.map(r => ({ t: u(r.d), m: r.m, elo: r.elo })),
  }));
  players.forEach(p => p.rel.sort((a, b) => a.t - b.t));

  const milestones = D.milestones.map(m => ({ ...m, t: u(m.d), sec: animSecOf(u(m.d)) }));
  const CARD_DUR = 5.0;

  const easeOutCubic = x => 1 - Math.pow(1 - x, 3);
  const easeInOut = x => x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
  const clamp01 = x => Math.max(0, Math.min(1, x));

  // Elo "morbido" di un player al tempo t (null se non ancora in gara)
  function eloAt(p, t) {
    if (t < p.rel[0].t) return null;
    let v = p.rel[0].elo;
    for (let i = 1; i < p.rel.length; i++) {
      const r = p.rel[i];
      if (t < r.t) break;
      v += (r.elo - v) * easeOutCubic(clamp01((t - r.t) / RAMP));
    }
    return v;
  }
  function modelAt(p, t) {
    let m = p.rel[0].m;
    for (const r of p.rel) { if (t >= r.t) m = r.m; else break; }
    return m;
  }
  // Elo nominale dell'ultimo modello (per la classifica finale)
  function finalElo(p) { return p.rel[p.rel.length - 1].elo; }

  // --- geometria del grafico ---
  const ML = 104, MR = 476, MT = 250, MB = 96;
  const BAND_Y = 150, BAND_H = 84;   // fascia dei callout, sopra il grafico
  const BAR_TOP = 1560;          // scala delle barre nella classifica finale
  const OUTLIER = 230;           // punti sotto il leader oltre i quali si esce dalla scala
  const VIEW = { lo: 980, hi: 1565 };
  const xOf = t => ML + (W - ML - MR) * (t - D.tStart) / (D.tEnd - D.tStart);
  const yOf = e => H - MB - (H - MT - MB) * (e - VIEW.lo) / (VIEW.hi - VIEW.lo);

  // Finestra verticale grezza a un dato istante: racchiude i player in gara,
  // escludendo chi è troppo staccato dal leader (resta sotto il bordo).
  function rawWindow(tc) {
    const vals = [];
    for (const p of players) {
      const e = eloAt(p, tc);
      if (e !== null) vals.push(e);
    }
    if (!vals.length) return { lo: 1000, hi: 1150 };
    const hi = Math.max(...vals);
    const inScale = vals.filter(v => v >= hi - OUTLIER);
    let lo = Math.min(...inScale);
    let span = hi - lo;
    if (span < 150) { const mid = (lo + hi) / 2; return { lo: mid - 87, hi: mid + 88 }; }
    return { lo: lo - span * 0.13, hi: hi + span * 0.15 };
  }

  // Media sugli ultimi istanti: assorbe lo scatto quando un player entra in gara.
  function setView(sec) {
    const N = 12, BACK = 0.8;
    let lo = 0, hi = 0, wsum = 0;
    for (let i = 0; i < N; i++) {
      const w = 1 - i / N;
      const win = rawWindow(dataTime(Math.max(sec - BACK * i / (N - 1), INTRO_END)));
      lo += win.lo * w; hi += win.hi * w; wsum += w;
    }
    VIEW.lo = lo / wsum; VIEW.hi = hi / wsum;
  }

  // --- canvas ---
  const canvas = document.getElementById('stage');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBackground() {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    const g = ctx.createRadialGradient(W * 0.5, -200, 100, W * 0.5, -200, 1400);
    g.addColorStop(0, 'rgba(60,80,160,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawCrown(x, y, s, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - s, y);
    ctx.lineTo(x - s, y - s * 0.55);
    ctx.lineTo(x - s * 0.5, y - s * 0.2);
    ctx.lineTo(x, y - s * 0.75);
    ctx.lineTo(x + s * 0.5, y - s * 0.2);
    ctx.lineTo(x + s, y - s * 0.55);
    ctx.lineTo(x + s, y);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ------------------------------------------------------------------ intro
  function drawIntro(sec) {
    const inA = clamp01(sec / 1.0);
    const a2 = clamp01((sec - 1.0) / 0.9);
    const a3 = clamp01((sec - 2.0) / 0.9);
    const out = 1 - clamp01((sec - (INTRO_END - 0.9)) / 0.9);
    ctx.save();
    ctx.globalAlpha = out;
    ctx.textAlign = 'center';

    ctx.globalAlpha = inA * out;
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 118px ' + FONT;
    const rise = (1 - easeOutCubic(inA)) * 40;
    ctx.fillText('LA GARA DELL’AI', W / 2, 430 + rise);

    ctx.globalAlpha = a2 * out;
    ctx.fillStyle = 'rgba(210,220,245,0.95)';
    ctx.font = '400 44px ' + FONT;
    ctx.fillText('I modelli più potenti di ogni player, dal lancio di ChatGPT a oggi', W / 2, 530);

    ctx.globalAlpha = a3 * out;
    ctx.fillStyle = GOLD;
    ctx.font = '600 36px ' + FONT;
    ctx.fillText('novembre 2022 → agosto 2026  ·  punteggi LMArena Elo', W / 2, 620);

    ctx.globalAlpha = a3 * 0.75 * out;
    ctx.fillStyle = 'rgba(160,175,205,0.9)';
    ctx.font = '400 30px ' + FONT;
    ctx.fillText(players.length + ' player · 4 anni · un minuto', W / 2, 690);
    ctx.restore();
  }

  // ------------------------------------------------------------------- gara
  function drawAxes() {
    ctx.save();
    ctx.strokeStyle = 'rgba(140,160,200,0.14)';
    ctx.fillStyle = 'rgba(170,185,215,0.75)';
    ctx.lineWidth = 1;
    ctx.font = '400 24px ' + FONT;
    ctx.textAlign = 'right';
    const span = VIEW.hi - VIEW.lo;
    const step = span > 420 ? 100 : span > 230 ? 50 : 25;
    for (let e = Math.ceil(VIEW.lo / step) * step; e <= VIEW.hi; e += step) {
      const y = yOf(e);
      ctx.beginPath();
      ctx.moveTo(ML, y); ctx.lineTo(W - MR, y);
      ctx.stroke();
      ctx.fillText(String(e), ML - 14, y + 8);
    }
    ctx.textAlign = 'center';
    for (let yr = 2023; yr <= 2026; yr++) {
      const t = Date.UTC(yr, 0, 1);
      const x = xOf(t);
      ctx.strokeStyle = 'rgba(140,160,200,0.20)';
      ctx.beginPath();
      ctx.moveTo(x, MT - 6); ctx.lineTo(x, H - MB);
      ctx.stroke();
      ctx.fillStyle = 'rgba(170,185,215,0.85)';
      ctx.font = '600 26px ' + FONT;
      ctx.fillText(String(yr), x, H - MB + 40);
    }
    // etichetta asse Y
    ctx.save();
    ctx.translate(34, (MT + H - MB) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = 'rgba(150,165,200,0.7)';
    ctx.font = '600 24px ' + FONT;
    ctx.fillText('LMArena Elo', 0, 0);
    ctx.restore();
    ctx.restore();
  }

  function drawHeader(tc) {
    ctx.save();
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 40px ' + FONT;
    ctx.fillText('LA GARA DELL’AI', ML, 64);
    ctx.fillStyle = 'rgba(170,185,215,0.85)';
    ctx.font = '400 26px ' + FONT;
    ctx.fillText('il modello più potente di ogni player · LMArena Elo', ML + 396, 63);

    const dt = new Date(tc);
    ctx.textAlign = 'right';
    ctx.fillStyle = GOLD;
    ctx.font = '800 54px ' + FONT;
    ctx.fillText(MESI[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear(), W - 60, 70);
    ctx.restore();
  }

  function drawMilestone(sec) {
    let cur = null, end = 0;
    for (let i = 0; i < milestones.length; i++) {
      const m = milestones[i], next = milestones[i + 1];
      const stop = Math.min(m.sec + CARD_DUR, next ? next.sec - 0.1 : Infinity);
      if (sec >= m.sec && sec < stop) { cur = m; end = stop; }
    }
    if (!cur) return;
    const lt = sec - cur.sec;
    const a = Math.min(clamp01(lt / 0.35), clamp01((end - sec) / 0.35));
    const cx = ML, cw = (W - MR) - ML, ch = BAND_H;
    const cy = BAND_Y - (1 - easeOutCubic(clamp01(lt / 0.4))) * 12;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(13,18,34,0.92)';
    roundRect(cx, cy, cw, ch, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,209,102,0.30)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = GOLD;
    ctx.fillRect(cx, cy + 12, 6, ch - 24);
    ctx.textAlign = 'left';
    const base = cy + 53;
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 36px ' + FONT;
    ctx.fillText(cur.title, cx + 30, base);
    const tw = ctx.measureText(cur.title).width;
    ctx.fillStyle = 'rgba(200,212,238,0.92)';
    ctx.font = '400 27px ' + FONT;
    ctx.fillText(cur.note, cx + 30 + tw + 26, base);
    ctx.restore();
  }

  function drawRace(sec, alpha) {
    const tc = dataTime(sec);
    setView(sec);
    ctx.save();
    ctx.globalAlpha = alpha;

    drawAxes();
    drawHeader(tc);

    // stato corrente dei player
    const state = [];
    for (const p of players) {
      const e = eloAt(p, tc);
      if (e !== null) state.push({ p, e, model: modelAt(p, tc) });
    }
    let leader = null;
    for (const s of state) if (!leader || s.e > leader.e) leader = s;

    // linea verticale "adesso"
    const xc = xOf(tc);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xc, MT); ctx.lineTo(xc, H - MB);
    ctx.stroke();

    // linee dei player (il leader per ultimo, sopra gli altri)
    const ordered = state.slice().sort((a, b) => (a === leader) - (b === leader));
    for (const s of ordered) {
      const p = s.p;
      const isLead = s === leader;
      const x0 = xOf(p.rel[0].t);
      ctx.save();
      ctx.beginPath();
      ctx.rect(ML - 2, MT - 24, (W - MR) - ML + 6, (H - MB) - MT + 26);
      ctx.clip();
      ctx.strokeStyle = p.color;
      ctx.globalAlpha = alpha * (isLead ? 1 : 0.62);
      ctx.lineWidth = isLead ? 5 : 3;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (isLead) { ctx.shadowColor = p.color; ctx.shadowBlur = 16; }
      ctx.beginPath();
      let first = true;
      for (let x = x0; x <= xc; x += 2) {
        const t = D.tStart + (x - ML) / (W - ML - MR) * (D.tEnd - D.tStart);
        const e = eloAt(p, Math.min(t, tc));
        if (e === null) continue;
        const y = yOf(e);
        if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
      }
      const yTip = yOf(s.e);
      ctx.lineTo(xc, yTip);
      ctx.stroke();
      ctx.restore();

      // impulsi sulle release appena avvenute
      for (const r of p.rel) {
        if (r.t > tc) break;
        const ds = sec - animSecOf(r.t);
        if (ds >= 0 && ds < 0.9) {
          const k = ds / 0.9;
          ctx.save();
          ctx.globalAlpha = alpha * (1 - k);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(xOf(r.t), yOf(eloAt(p, r.t)), 6 + 26 * easeOutCubic(k), 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // etichette sulla punta, con anti-collisione
    const labels = state.map(s => {
      const off = s.e < VIEW.lo;
      return {
        s, off,
        want: Math.min(Math.max(yOf(s.e), MT + 12), H - MB - 12),
        text: (off ? '↓ ' : '') + (s.p.shortName || s.p.name) + ' · ' + s.model,
      };
    }).sort((a, b) => a.want - b.want);
    const GAP = 29;
    for (let i = 0; i < labels.length; i++) {
      labels[i].y = i === 0 ? labels[i].want : Math.max(labels[i].want, labels[i - 1].y + GAP);
    }
    const maxY = H - MB - 6;
    if (labels.length && labels[labels.length - 1].y > maxY) {
      labels[labels.length - 1].y = maxY;
      for (let i = labels.length - 2; i >= 0; i--) {
        labels[i].y = Math.min(labels[i].y, labels[i + 1].y - GAP);
      }
    }
    ctx.textAlign = 'left';
    for (const L of labels) {
      const isLead = L.s === leader;
      const px = xc, py = L.want;
      // punto sulla punta
      ctx.save();
      ctx.fillStyle = L.s.p.color;
      ctx.beginPath();
      ctx.arc(px, py, isLead ? 7 : 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // connettore se l'etichetta è stata spostata
      if (Math.abs(L.y - py) > 4) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px + 8, py);
        ctx.lineTo(px + 20, L.y - 8);
        ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      const fx = px + 26;
      if (L.s.p.flag) {
        ctx.font = '17px ' + EFONT;
        ctx.fillText(L.s.p.flag, fx, L.y);
      }
      const tx = fx + (L.s.p.flag ? 27 : 0);
      ctx.fillStyle = L.s.p.color;
      ctx.font = (isLead ? '800 23px ' : '600 19px ') + FONT;
      ctx.fillText(L.text, tx, L.y);
      ctx.fillStyle = 'rgba(235,240,250,0.85)';
      ctx.font = '400 18px ' + FONT;
      ctx.fillText(String(Math.round(L.s.e)), tx + measure(L.text, isLead) + 12, L.y);
      if (isLead) drawCrown(px, py - 16, 11, GOLD);
      ctx.restore();
    }

    drawMilestone(sec);

    // nota a piè di pagina
    ctx.fillStyle = 'rgba(150,165,200,0.55)';
    ctx.font = '400 20px ' + FONT;
    ctx.textAlign = 'left';
    ctx.fillText('Punteggi Elo indicativi (scala attuale LMArena) · Microsoft: modelli propri Phi/MAI — Copilot usa modelli OpenAI', ML, H - 26);
    ctx.restore();

    function measure(text, isLead) {
      ctx.save();
      ctx.font = (isLead ? '800 23px ' : '600 19px ') + FONT;
      const w = ctx.measureText(text).width;
      ctx.restore();
      return w;
    }
  }

  // -------------------------------------------------------------- classifica
  function drawFinal(sec, alpha) {
    const ranked = players
      .map(p => ({ p, e: finalElo(p), model: modelAt(p, D.tEnd) }))
      .sort((a, b) => b.e - a.e);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 64px ' + FONT;
    ctx.fillText('AGOSTO 2026 — LA CLASSIFICA', W / 2, 120);
    ctx.fillStyle = 'rgba(180,195,225,0.9)';
    ctx.font = '400 30px ' + FONT;
    ctx.fillText('il miglior modello di ogni player · LMArena Elo', W / 2, 168);

    const t0 = RACE_END + 0.6;
    const rowH = 52, top = 202;
    const xRank = 210, xName = 252, barX = 900, barMax = 590, xElo = barX + barMax + 26;

    ranked.forEach((r, i) => {
      const st = t0 + i * 0.34;
      const k = clamp01((sec - st) / 0.5);
      if (k <= 0) return;
      const y = top + i * rowH;
      const grow = easeOutCubic(clamp01((sec - st) / 0.7));
      ctx.save();
      ctx.globalAlpha = alpha * k;
      ctx.textAlign = 'right';
      ctx.fillStyle = i === 0 ? GOLD : 'rgba(190,200,225,0.9)';
      ctx.font = '800 30px ' + FONT;
      ctx.fillText(String(i + 1), xRank, y + 10);

      ctx.beginPath();
      ctx.fillStyle = r.p.color;
      ctx.arc(xName + 12, y, 10, 0, Math.PI * 2);
      ctx.fill();

      ctx.textAlign = 'left';
      if (r.p.flag) {
        ctx.font = '21px ' + EFONT;
        ctx.fillText(r.p.flag, xName + 34, y + 9);
      }
      const nx = xName + 34 + (r.p.flag ? 34 : 0);
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 25px ' + FONT;
      ctx.fillText(r.p.name, nx, y + 9);
      ctx.fillStyle = 'rgba(190,202,230,0.95)';
      ctx.font = '400 22px ' + FONT;
      ctx.fillText(r.model, nx + nameW(r.p.name) + 18, y + 9);

      const len = barMax * (r.e - 1000) / (BAR_TOP - 1000) * grow;
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      roundRect(barX, y - 14, barMax, 27, 7);
      ctx.fill();
      ctx.fillStyle = r.p.color;
      roundRect(barX, y - 14, Math.max(len, 12), 27, 7);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = '700 25px ' + FONT;
      ctx.fillText(String(Math.round(1000 + (r.e - 1000) * grow)), xElo, y + 9);
      if (i === 0 && grow > 0.9) drawCrown(barX + len - 22, y - 20, 11, GOLD);
      ctx.restore();
    });

    const aTag = clamp01((sec - TAG_AT) / 0.8);
    if (aTag > 0) {
      ctx.globalAlpha = alpha * aTag;
      ctx.textAlign = 'center';
      ctx.fillStyle = GOLD;
      ctx.font = '600 40px ' + FONT;
      ctx.fillText('…e la gara continua.', W / 2, 996);
    }

    ctx.globalAlpha = alpha * 0.75;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(150,165,200,0.8)';
    ctx.font = '400 21px ' + FONT;
    ctx.fillText('Punteggi Elo indicativi · fonte LMArena (ago 2026) · Microsoft: modelli propri MAI/Phi (Copilot usa modelli OpenAI) · adecordi.github.io/ai-race', W / 2, 1054);
    ctx.restore();

    function nameW(name) {
      ctx.save();
      ctx.font = '700 25px ' + FONT;
      const w = ctx.measureText(name).width;
      ctx.restore();
      return w;
    }
  }

  // ------------------------------------------------------------------ frame
  function drawFrame(frame) {
    const sec = Math.min(frame, TOTAL - 1) / FPS;
    drawBackground();

    if (sec < INTRO_END) {
      const raceIn = clamp01((sec - (INTRO_END - 0.9)) / 0.9);
      if (raceIn > 0) drawRace(sec, raceIn * 0.9);
      drawIntro(sec);
    } else if (sec < RACE_END) {
      const out = 1 - clamp01((sec - (RACE_END - 0.5)) / 0.5);
      drawRace(sec, out);
      if (out < 1) drawFinal(sec, 1 - out);
    } else {
      drawFinal(sec, 1);
    }

    // barra di avanzamento
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, H - 5, W, 5);
    ctx.fillStyle = GOLD;
    ctx.fillRect(0, H - 5, W * (sec / DUR), 5);
  }

  // ------------------------------------------------------- riproduzione web
  const params = new URLSearchParams(location.search);
  const renderMode = params.get('render') === '1';

  let playing = false;
  let frame = 0;
  let lastTs = null;

  function tick(ts) {
    if (!playing) return;
    if (lastTs === null) lastTs = ts;
    frame += (ts - lastTs) / 1000 * FPS;
    lastTs = ts;
    if (frame >= TOTAL - 1) { frame = TOTAL - 1; playing = false; updateBtn(); }
    drawFrame(Math.floor(frame));
    updateScrub();
    if (playing) requestAnimationFrame(tick);
  }

  const btn = document.getElementById('playpause');
  const scrub = document.getElementById('scrub');
  function updateBtn() { if (btn) btn.textContent = playing ? '❚❚  Pausa' : '▶  Play'; }
  function updateScrub() { if (scrub) scrub.value = String(Math.floor(frame)); }

  function play() {
    if (frame >= TOTAL - 1) frame = 0;
    playing = true; lastTs = null; updateBtn();
    requestAnimationFrame(tick);
  }
  function pause() { playing = false; updateBtn(); }

  if (btn) btn.addEventListener('click', () => (playing ? pause() : play()));
  const restart = document.getElementById('restart');
  if (restart) restart.addEventListener('click', () => { frame = 0; play(); });
  if (scrub) {
    scrub.max = String(TOTAL - 1);
    scrub.addEventListener('input', () => {
      pause();
      frame = +scrub.value;
      drawFrame(Math.floor(frame));
    });
  }

  // API per il rendering deterministico
  window.TOTAL_FRAMES = TOTAL;
  window.seekFrame = function (n) {
    frame = Math.max(0, Math.min(TOTAL - 1, n));
    drawFrame(frame);
    return canvas.toDataURL('image/png');
  };

  drawFrame(0);
  if (!renderMode) play();
})();
