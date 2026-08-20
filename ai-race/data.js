// ============================================================================
// LA GARA DELL'AI — dataset
// Il miglior modello di ciascun player nel tempo, con punteggio LMArena Elo
// (Chatbot Arena) sulla scala attuale del leaderboard.
//
// NOTA SUI DATI: i punteggi Elo di LMArena vengono ricalcolati continuamente
// e la scala è derivata nel tempo; i valori qui sotto sono INDICATIVI,
// curati per riflettere fedelmente l'ordine e le distanze relative tra i
// modelli in ciascun periodo. Fonti: leaderboard LMArena, annunci ufficiali
// dei vendor, Wikipedia, Artificial Analysis (snapshot ago 2026).
// Copilot di Microsoft si appoggia ai modelli OpenAI: per Microsoft contano
// qui i modelli proprietari (Phi, MAI).
// ============================================================================

window.AIRACE_DATA = {
  tStart: Date.UTC(2022, 10, 1),   // 1 nov 2022
  tEnd:   Date.UTC(2026, 7, 19),   // 19 ago 2026 (oggi)

  players: [
    {
      id: 'openai', name: 'OpenAI', flag: '🇺🇸', color: '#10c99a',
      releases: [
        { d: '2022-11-30', m: 'GPT-3.5 (ChatGPT)', elo: 1075 },
        { d: '2023-03-14', m: 'GPT-4',             elo: 1190 },
        { d: '2023-11-06', m: 'GPT-4 Turbo',       elo: 1250 },
        { d: '2024-05-13', m: 'GPT-4o',            elo: 1290 },
        { d: '2024-12-05', m: 'o1',                elo: 1355 },
        { d: '2025-04-16', m: 'o3',                elo: 1415 },
        { d: '2025-08-07', m: 'GPT-5',             elo: 1465 },
        { d: '2025-12-11', m: 'GPT-5.2',           elo: 1481 },
        { d: '2026-03-05', m: 'GPT-5.4',           elo: 1490 },
        { d: '2026-04-23', m: 'GPT-5.5',           elo: 1497 },
        { d: '2026-07-08', m: 'GPT-5.6',           elo: 1512 },
      ],
    },
    {
      id: 'google', name: 'Google', flag: '🇺🇸', color: '#4c8bf5',
      releases: [
        { d: '2023-03-21', m: 'Bard (LaMDA)',   elo: 1035 },
        { d: '2023-05-10', m: 'PaLM 2',         elo: 1090 },
        { d: '2023-12-06', m: 'Gemini Pro',     elo: 1135 },
        { d: '2024-02-15', m: 'Gemini 1.5 Pro', elo: 1255 },
        { d: '2024-12-11', m: 'Gemini 2.0',     elo: 1350 },
        { d: '2025-03-25', m: 'Gemini 2.5 Pro', elo: 1440 },
        { d: '2025-11-18', m: 'Gemini 3 Pro',   elo: 1492 },
        { d: '2026-02-19', m: 'Gemini 3.1 Pro', elo: 1506 },
      ],
    },
    {
      id: 'anthropic', name: 'Anthropic', flag: '🇺🇸', color: '#e07a52',
      releases: [
        { d: '2023-03-14', m: 'Claude 1',          elo: 1120 },
        { d: '2023-07-11', m: 'Claude 2',          elo: 1135 },
        { d: '2024-03-04', m: 'Claude 3 Opus',     elo: 1255 },
        { d: '2024-06-20', m: 'Claude 3.5 Sonnet', elo: 1275 },
        { d: '2025-02-24', m: 'Claude 3.7 Sonnet', elo: 1305 },
        { d: '2025-05-22', m: 'Claude Opus 4',     elo: 1420 },
        { d: '2025-11-24', m: 'Claude Opus 4.5',   elo: 1470 },
        { d: '2026-04-16', m: 'Claude Opus 4.7',   elo: 1499 },
        { d: '2026-05-28', m: 'Claude Opus 4.8',   elo: 1511 },
        { d: '2026-06-09', m: 'Claude Fable 5',    elo: 1525 },
      ],
    },
    {
      id: 'meta', name: 'Meta', flag: '🇺🇸', color: '#2f80ed',
      releases: [
        { d: '2023-02-24', m: 'LLaMA',            elo: 1005 },
        { d: '2023-07-18', m: 'Llama 2',          elo: 1080 },
        { d: '2024-04-18', m: 'Llama 3',          elo: 1210 },
        { d: '2024-07-23', m: 'Llama 3.1 405B',   elo: 1270 },
        { d: '2025-04-05', m: 'Llama 4 Maverick', elo: 1292 },
        { d: '2026-04-08', m: 'Muse Spark',       elo: 1491 },
      ],
    },
    {
      id: 'xai', name: 'xAI', flag: '🇺🇸', color: '#e8e8ec',
      releases: [
        { d: '2023-11-04', m: 'Grok-1',   elo: 1075 },
        { d: '2024-08-13', m: 'Grok 2',   elo: 1288 },
        { d: '2025-02-17', m: 'Grok 3',   elo: 1400 },
        { d: '2025-07-09', m: 'Grok 4',   elo: 1435 },
        { d: '2025-11-17', m: 'Grok 4.1', elo: 1477 },
        { d: '2026-04-10', m: 'Grok 4.3', elo: 1489 },
        { d: '2026-07-08', m: 'Grok 4.5', elo: 1500 },
        { d: '2026-08-12', m: 'Grok 4.6', elo: 1516 },
      ],
    },
    {
      id: 'deepseek', name: 'DeepSeek', flag: '🇨🇳', color: '#6c7bff',
      releases: [
        { d: '2023-11-29', m: 'DeepSeek LLM',     elo: 1078 },
        { d: '2024-05-06', m: 'DeepSeek-V2',      elo: 1220 },
        { d: '2024-12-26', m: 'DeepSeek-V3',      elo: 1310 },
        { d: '2025-01-20', m: 'DeepSeek-R1',      elo: 1360 },
        { d: '2025-05-28', m: 'R1-0528',          elo: 1400 },
        { d: '2025-09-29', m: 'DeepSeek-V3.2',    elo: 1418 },
        { d: '2026-04-24', m: 'V4 Preview',       elo: 1442 },
        { d: '2026-08-13', m: 'DeepSeek V4-Pro',  elo: 1455 },
      ],
    },
    {
      id: 'microsoft', name: 'Microsoft', flag: '🇺🇸', color: '#39c5f3',
      releases: [
        { d: '2024-04-23', m: 'Phi-3',          elo: 1095 },
        { d: '2024-12-12', m: 'Phi-4',          elo: 1205 },
        { d: '2025-08-28', m: 'MAI-1-preview',  elo: 1240 },
        { d: '2026-06-02', m: 'MAI-Thinking-1', elo: 1395 },
      ],
    },
    {
      id: 'mistral', name: 'Mistral', flag: '🇫🇷', color: '#ff8f2d',
      releases: [
        { d: '2023-09-27', m: 'Mistral 7B',         elo: 1010 },
        { d: '2023-12-11', m: 'Mixtral 8x7B',       elo: 1120 },
        { d: '2024-02-26', m: 'Mistral Large',      elo: 1160 },
        { d: '2024-07-24', m: 'Mistral Large 2',    elo: 1250 },
        { d: '2025-05-07', m: 'Mistral Medium 3',   elo: 1345 },
        { d: '2025-12-02', m: 'Mistral Large 3',    elo: 1420 },
        { d: '2026-04-29', m: 'Mistral Medium 3.5', elo: 1442 },
      ],
    },
    {
      id: 'qwen', name: 'Alibaba (Qwen)', shortName: 'Qwen', flag: '🇨🇳', color: '#b06bf7',
      releases: [
        { d: '2023-12-01', m: 'Qwen-72B',    elo: 1090 },
        { d: '2024-06-07', m: 'Qwen2-72B',   elo: 1190 },
        { d: '2024-09-19', m: 'Qwen2.5-72B', elo: 1260 },
        { d: '2025-01-28', m: 'Qwen2.5-Max', elo: 1340 },
        { d: '2025-04-29', m: 'Qwen3-235B',  elo: 1372 },
        { d: '2025-09-24', m: 'Qwen3-Max',   elo: 1430 },
        { d: '2026-05-20', m: 'Qwen3.7 Max', elo: 1475 },
        { d: '2026-08-03', m: 'Qwen3.8 Max', elo: 1490 },
      ],
    },
    {
      id: 'moonshot', name: 'Moonshot (Kimi)', shortName: 'Kimi', flag: '🇨🇳', color: '#ff5c8a',
      releases: [
        { d: '2023-10-09', m: 'Kimi Chat',       elo: 1060 },
        { d: '2024-11-16', m: 'Kimi k0-math',    elo: 1215 },
        { d: '2025-01-20', m: 'Kimi k1.5',       elo: 1352 },
        { d: '2025-07-11', m: 'Kimi K2',         elo: 1425 },
        { d: '2025-11-06', m: 'K2 Thinking',     elo: 1460 },
        { d: '2026-01-27', m: 'Kimi K2.5',       elo: 1472 },
        { d: '2026-04-15', m: 'Kimi K2.6',       elo: 1481 },
        { d: '2026-07-16', m: 'Kimi K3',         elo: 1498 },
      ],
    },
    {
      id: 'zhipu', name: 'Z.ai (Zhipu)', shortName: 'Z.ai', flag: '🇨🇳', color: '#9ad34a',
      releases: [
        { d: '2023-03-14', m: 'ChatGLM-6B',   elo: 1000 },
        { d: '2024-01-16', m: 'GLM-4',        elo: 1150 },
        { d: '2024-08-29', m: 'GLM-4-Plus',   elo: 1245 },
        { d: '2025-07-28', m: 'GLM-4.5',      elo: 1400 },
        { d: '2025-09-30', m: 'GLM-4.6',      elo: 1425 },
        { d: '2026-02-11', m: 'GLM-5',        elo: 1478 },
        { d: '2026-07-01', m: 'GLM-5.3',      elo: 1492 },
      ],
    },
    {
      id: 'bytedance', name: 'ByteDance', shortName: 'ByteDance', flag: '🇨🇳', color: '#14b8a6',
      releases: [
        { d: '2024-05-15', m: 'Doubao Pro',      elo: 1150 },
        { d: '2025-01-22', m: 'Doubao 1.5 Pro',  elo: 1310 },
        { d: '2025-06-11', m: 'Doubao-Seed 1.6', elo: 1400 },
        { d: '2026-02-14', m: 'Doubao-Seed 2.0', elo: 1465 },
        { d: '2026-06-23', m: 'Seed 2.1',        elo: 1487 },
      ],
    },
    {
      id: 'minimax', name: 'MiniMax', flag: '🇨🇳', color: '#ff4d4d',
      releases: [
        { d: '2024-04-17', m: 'abab6.5',     elo: 1120 },
        { d: '2025-01-15', m: 'Text-01',     elo: 1290 },
        { d: '2025-06-17', m: 'MiniMax M1',  elo: 1380 },
        { d: '2025-10-27', m: 'MiniMax M2',  elo: 1440 },
        { d: '2026-06-01', m: 'MiniMax M3',  elo: 1483 },
      ],
    },
    {
      id: 'baidu', name: 'Baidu', flag: '🇨🇳', color: '#d9a441',
      releases: [
        { d: '2023-03-16', m: 'ERNIE Bot',       elo: 1020 },
        { d: '2023-10-17', m: 'ERNIE 4.0',       elo: 1130 },
        { d: '2024-06-28', m: 'ERNIE 4.0 Turbo', elo: 1230 },
        { d: '2025-03-16', m: 'ERNIE 4.5',       elo: 1330 },
        { d: '2025-11-13', m: 'ERNIE 5.0',       elo: 1462 },
      ],
    },
    {
      // Emma non e mai stata misurata su LMArena: il valore e una STIMA, coerente
      // con le prove pubbliche del giugno 2026 (demo sospesa dopo tre giorni).
      id: 'egomnia', name: 'Egomnia (Emma)', shortName: 'Emma', flag: '🇮🇹', color: '#5bd672',
      releases: [
        { d: '2026-06-23', m: 'Emma-5 (stima)', elo: 1050 },
      ],
    },
  ],

  // Callout mostrati durante la gara (data di attivazione + titolo + nota)
  milestones: [
    { d: '2022-11-30', title: 'ChatGPT dà il via',      note: '100 milioni di utenti in due mesi: parte la corsa' },
    { d: '2023-03-14', title: 'GPT-4',                  note: 'MMLU 86%: il primo grande salto di capacità' },
    { d: '2023-07-18', title: 'Meta apre i pesi',       note: 'Llama 2 è libero anche per usi commerciali' },
    { d: '2023-09-27', title: 'L’Europa si presenta',   note: 'Mistral 7B batte modelli il doppio più grandi' },
    { d: '2023-12-06', title: 'Arriva Gemini',          note: 'la corsa diventa a più voci' },
    { d: '2024-03-04', title: 'Claude 3 Opus',          note: 'Anthropic sorpassa GPT-4 in Arena' },
    { d: '2024-05-13', title: 'GPT-4o',                 note: 'multimodale in tempo reale, e gratis per tutti' },
    { d: '2024-07-23', title: 'Llama 3.1 405B',         note: 'l’open source di Meta raggiunge i frontier' },
    { d: '2024-09-19', title: 'La Cina accelera',       note: 'Qwen2.5: pesi aperti e prezzi che crollano' },
    { d: '2024-12-05', title: 'Nasce il reasoning',     note: 'o1: il modello che ragiona prima di rispondere' },
    { d: '2025-01-20', title: 'La Cina al frontier',    note: 'DeepSeek R1 e Kimi k1.5: frontier a costo minimo' },
    { d: '2025-03-25', title: 'Gemini 2.5 Pro',         note: 'Google torna in testa, GPQA sopra l’80%' },
    { d: '2025-05-22', title: 'Claude Opus 4',          note: 'il codice diventa il vero campo di battaglia' },
    { d: '2025-08-07', title: 'GPT-5 debutta',          note: 'SWE-bench Verified oltre il 75%' },
    { d: '2025-09-29', title: 'L’onda open-weight',     note: 'Qwen3-Max e DeepSeek V3.2 incalzano i chiusi' },
    { d: '2025-11-18', title: 'Gemini 3 e Grok 4.1',    note: 'quota 1490: il gruppo di testa si compatta' },
    { d: '2026-02-19', title: 'Cade quota 1500',        note: 'Gemini 3.1 rompe il muro, otto player entro 50 punti' },
    { d: '2026-04-08', title: 'Meta cambia strada',     note: 'Muse Spark: primo modello chiuso, niente pesi' },
    { d: '2026-06-09', title: 'Claude Fable 5',         note: 'nuovo n.1 in Arena — distacchi mai così piccoli' },
    { d: '2026-07-08', title: 'GPT-5.6 e Grok 4.5',     note: 'il vertice cambia ogni poche settimane' },
    { d: '2026-07-28', title: 'Emma, l’IA italiana',    note: 'lanciata a giugno da Egomnia, demo sospesa dopo 3 giorni' },
  ],
};
