// EasyMed PWA service worker (PWA_V1) — install-only, NO caching (always network) so it can
// NEVER serve stale code. Its only job is to make the app installable.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* passthrough: no respondWith -> browser does the network fetch */ });
