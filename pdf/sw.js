// C-A-R-T-A si è spostata su https://c-a-r-t-a.it/app/ (01/11/2026). Questo service worker sostituisce quello vecchio
// installato da questo indirizzo: svuota la cache, si disinstalla e porta ogni finestra aperta alla nuova sede.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: "window" })) c.navigate("https://c-a-r-t-a.it/app/");
  })());
});
