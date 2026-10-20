'use strict';

const CACHE = 'scrim-3';
const ROOT = new URL('./', self.location.href);
const SHELL = ['index.html', 'style.css', 'app.js', 'vendor/tesseract.min.js', 'fixtures/help.png'];
const STATIC = new Set([...SHELL, 'vendor/worker.min.js', 'vendor/lang/eng.traineddata.gz'].map(path => new URL(path, ROOT).pathname));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(path => new URL(path, ROOT).href))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('scrim-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== ROOT.origin || url.search) return;
  const core = url.pathname.startsWith(ROOT.pathname + 'vendor/core/') && /^tesseract-core(?:-[a-z]+)*\.wasm\.js$/.test(url.pathname.split('/').pop());
  const home = url.pathname === ROOT.pathname;
  if (!home && !STATIC.has(url.pathname) && !core) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(home ? new URL('index.html', ROOT).href : event.request);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok && response.type !== 'opaque') await cache.put(event.request, response.clone());
    return response;
  }));
});
