// Service worker: rende il lettore utilizzabile anche offline e riceve i file
// condivisi da altre app (Android). Aggiornare VERSION a ogni modifica dei file.
const VERSION = "2026-10-30.8";
const CACHE = `lettore-pdf-${VERSION}`;
const SHARED_CACHE = "lettore-pdf-condivisi";

const CORE = [
  "./",
  "app.js",
  "p7m.js",
  "dom.js",
  "viewer.js",
  "testo.js",
  "firma.js",
  "compila.js",
  "fattura.js",
  "print-encoder.js",
  "outlook.js",
  "style.css",
  "fonts/josefin-sans-latin.woff2",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/logo.svg",
  "icons/icon-192.png",
  "lib/pdfjs/pdf.min.mjs",
  "lib/pdfjs/pdf.worker.min.mjs",
  "lib/pdfjs/pdf_viewer.min.mjs",
  "lib/pdfjs/pdf_viewer.min.css",
  "lib/pdfjs/images/loading-icon.gif",
  // Decodificatori delle immagini usate spesso nelle scansioni (JBIG2, JPEG 2000) e profili colore.
  "lib/pdfjs/wasm/jbig2.wasm",
  "lib/pdfjs/wasm/openjpeg.wasm",
  "lib/pdfjs/wasm/qcms_bg.wasm",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(CORE.map((url) => new Request(url, { cache: "reload" }))))
      // La versione nuova aspetta il tasto «Aggiorna» (30/10/2026). Eccezione: se c'è ancora una
      // versione di prima del tasto, che non saprebbe mostrarlo, questa si attiva da sola.
      .then(async () => {
        const vecchie = (await caches.keys()).filter((k) => /^lettore-pdf-\d/.test(k) && k !== CACHE);
        if (vecchie.some((k) => primaDelTasto(k.slice("lettore-pdf-".length)))) await self.skipWaiting();
      })
  );
});

// «2026-10-30.4» e prima: versioni senza il tasto «Aggiorna» che compare da solo.
function primaDelTasto(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})\.(\d+)$/.exec(v);
  if (!m) return false;
  const giorno = m[1] + m[2] + m[3];
  return giorno < "20261030" || (giorno === "20261030" && Number(m[4]) < 5);
}

// Il lettore chiede di attivare la versione nuova quando si preme «Aggiorna».
self.addEventListener("message", (event) => {
  if (event.data === "attiva") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith("lettore-pdf-") && k !== CACHE && k !== SHARED_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === "POST" && url.searchParams.has("share-target")) {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== "GET" || url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  event.respondWith(fromCache(req));
});

// Prima la cache (versionata), poi la rete; le risorse caricate su richiesta
// (cmaps, font, wasm) vengono aggiunte alla cache al primo utilizzo.
async function fromCache(req) {
  const cache = await caches.open(CACHE);
  const key = req.mode === "navigate" ? new URL("./", self.registration.scope).href : req;
  const cached = await cache.match(key, { ignoreSearch: req.mode === "navigate" });
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok && res.type === "basic" && req.mode !== "navigate") cache.put(req, res.clone());
  return res;
}

async function receiveShare(req) {
  try {
    const form = await req.formData();
    const file = form.getAll("file").find((f) => typeof f !== "string");
    if (file) {
      const cache = await caches.open(SHARED_CACHE);
      await cache.put(new URL("condiviso", self.registration.scope).href, new Response(file, {
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name || "documento"),
        },
      }));
    }
  } catch (e) {
    // Se qualcosa va storto si apre comunque il lettore.
  }
  return Response.redirect(new URL("./?condiviso=1", self.registration.scope).href, 303);
}
