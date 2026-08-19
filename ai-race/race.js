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
  const FPS = 30, DUR = 60;
  const TOTAL = FPS * DUR;

  const INTRO_END = 4.5;   // s: fine intro
  const RACE_HOLD = 50.0;  // s: il cursore temporale arriva a "oggi"
  const RACE_END  = 52.0;  // s: inizio transizione alla classifica

  const FONT = '"Inter","Segoe UI",Arial,sans-serif';
  const BG = '#0b0f1a';
  const GOLD = '#ffd166';
  const MESI = ['gennaio','febbraio','marzo','aprile','maggio','giugno',
                'luglio','agosto','settembre','ottobre','novembre','dicembre'];

  const DAY = 86400000;
  const RAMP = 40 * DAY; // giorni di "salita" morbida dopo ogni release

  function u(s) { const p = s.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }

  // --- pianificazione tempo-animazione -> tempo-dati (piecewise lineare) ---
  const SCHED = [
    [INTRO_END, u('2022-11-30')],
    [10.0, u('2023-06-01')],
    [15.5, u('2024-01-01')],
    [22.0, u('2024-09-01')],
    [27.0, u('2025-01-25')],
    [33.0, u('2025-08-01')],
    [38.0, u('2026-01-01')],
    [RACE_HOLD, D.tEnd],
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
  const CARD_DUR = 3.2;

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
  const ML = 104, MR = 408, MT = 138, MB = 96;
  const EMIN = 980, EMAX = 1565;
  const xOf = t => ML + (W - ML - MR) * (t - D.tStart) / (D.tEnd - D.tStart);
  const yOf = e => H - MB - (H - MT - MB) * (e - EMIN) / (EMAX - EMIN);

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
    const inA = clamp01(sec / 0.8);
    const a2 = clamp01((sec - 0.7) / 0.8);
    const a3 = clamp01((sec - 1.5) / 0.8);
    const out = 1 - clamp01((sec - (INTRO_END - 0.6)) / 0.6);
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
    ctx.fillText('9 player · 4 anni · un minuto', W / 2, 690);
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
    for (let e = 1000; e <= 1500; e += 100) {
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
    let cur = null;
    for (const m of milestones) {
      if (sec >= m.sec && sec < m.sec + CARD_DUR) cur = m;
    }
    if (!cur) return;
    const lt = sec - cur.sec;
    const a = Math.min(clamp01(lt / 0.35), clamp01((CARD_DUR - lt) / 0.35));
    const cw = 640, ch = 116;
    const cx = ML + 18, cy = MT + 10 - (1 - easeOutCubic(clamp01(lt / 0.4))) * 14;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(13,18,34,0.94)';
    roundRect(cx, cy, cw, ch, 14);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,209,102,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = GOLD;
    ctx.fillRect(cx, cy + 10, 6, ch - 20);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 36px ' + FONT;
    ctx.fillText(cur.title, cx + 28, cy + 48);
    ctx.fillStyle = 'rgba(200,212,238,0.95)';
    ctx.font = '400 27px ' + FONT;
    ctx.fillText(cur.note, cx + 28, cy + 90);
    ctx.restore();
  }

  function drawRace(sec, alpha) {
    const tc = dataTime(sec);
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
    const labels = state.map(s => ({
      s, want: yOf(s.e),
      text: (s.p.shortName || s.p.name) + ' · ' + s.model,
    })).sort((a, b) => a.want - b.want);
    const GAP = 34;
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
      const px = xc, py = yOf(L.s.e);
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
      ctx.fillStyle = L.s.p.color;
      ctx.font = (isLead ? '800 25px ' : '600 21px ') + FONT;
      ctx.fillText(L.text, px + 26, L.y);
      ctx.fillStyle = 'rgba(235,240,250,0.85)';
      ctx.font = '400 20px ' + FONT;
      ctx.fillText(String(Math.round(L.s.e)), px + 26 + measure(L.text, isLead) + 12, L.y);
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
      ctx.font = (isLead ? '800 25px ' : '600 21px ') + FONT;
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
    const rowH = 82, top = 226;
    const xRank = 250, xName = 300, barX = 880, barMax = 660, xElo = barX + barMax + 30;

    ranked.forEach((r, i) => {
      const st = t0 + i * 0.24;
      const k = clamp01((sec - st) / 0.5);
      if (k <= 0) return;
      const y = top + i * rowH;
      const grow = easeOutCubic(clamp01((sec - st) / 0.7));
      ctx.save();
      ctx.globalAlpha = alpha * k;
      ctx.textAlign = 'right';
      ctx.fillStyle = i === 0 ? GOLD : 'rgba(190,200,225,0.9)';
      ctx.font = '800 40px ' + FONT;
      ctx.fillText(String(i + 1), xRank, y + 14);

      ctx.beginPath();
      ctx.fillStyle = r.p.color;
      ctx.arc(xName + 16, y, 13, 0, Math.PI * 2);
      ctx.fill();

      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 32px ' + FONT;
      ctx.fillText(r.p.name, xName + 46, y + 12);
      ctx.fillStyle = 'rgba(190,202,230,0.95)';
      ctx.font = '400 28px ' + FONT;
      ctx.fillText(r.model, xName + 46 + nameW(r.p.name) + 22, y + 12);

      const len = barMax * (r.e - 1000) / (EMAX - 1000) * grow;
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      roundRect(barX, y - 17, barMax, 34, 8);
      ctx.fill();
      ctx.fillStyle = r.p.color;
      roundRect(barX, y - 17, Math.max(len, 12), 34, 8);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = '700 32px ' + FONT;
      ctx.fillText(String(Math.round(1000 + (r.e - 1000) * grow)), xElo, y + 12);
      if (i === 0 && grow > 0.9) drawCrown(barX + len - 26, y - 24, 13, GOLD);
      ctx.restore();
    });

    const aTag = clamp01((sec - 57.2) / 0.7);
    if (aTag > 0) {
      ctx.globalAlpha = alpha * aTag;
      ctx.textAlign = 'center';
      ctx.fillStyle = GOLD;
      ctx.font = '600 40px ' + FONT;
      ctx.fillText('…e la gara continua.', W / 2, 1002);
    }

    ctx.globalAlpha = alpha * 0.75;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(150,165,200,0.8)';
    ctx.font = '400 21px ' + FONT;
    ctx.fillText('Punteggi Elo indicativi · fonte LMArena (ago 2026) · Microsoft: modelli propri MAI/Phi (Copilot usa modelli OpenAI) · adecordi.github.io/ai-race', W / 2, 1054);
    ctx.restore();

    function nameW(name) {
      ctx.save();
      ctx.font = '700 32px ' + FONT;
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
      const raceIn = clamp01((sec - (INTRO_END - 0.6)) / 0.6);
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
