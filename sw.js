// Service worker — gives the dashboard offline fallback, the "installable"
// PWA behaviour, and Web Push notifications for new fixtures.
// Bump CACHE_VERSION when shipping breaking changes to the shell.

const CACHE_VERSION = "firebirds-v72";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "icon.svg",
  "manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Network-first with HTTP-cache bypass: send a conditional request to
  // origin every time (cheap — 304 if unchanged, 200 with fresh body if
  // changed). Falls back to the SW cache only if the network is unreachable.
  // This means dashboard updates ship instantly when the user is online,
  // and the site still loads with last-known data when they're not.
  event.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        return resp;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("./")))
  );
});

// --- Web Push -----------------------------------------------------------

self.addEventListener("push", (event) => {
  // Payload shape (sent by send-push-notifications.py):
  //   { title, body, tag, url }
  // tag is the Spawtz fixture_id — using it as the notification tag means
  // a repeated push for the same fixture replaces the old notification
  // rather than stacking.
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { title: "Blazing Firebirds", body: event.data.text() };
    }
  }
  const title = data.title || "Blazing Firebirds";
  const options = {
    body: data.body || "",
    icon: "icon.svg",
    badge: "icon.svg",
    tag: data.tag ? String(data.tag) : "firebirds-fixture",
    renotify: true,
    data: { url: data.url || "./" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "./";
  const target = new URL(targetUrl, self.location.origin);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // If a dashboard window is already open, navigate it to the target
      // (e.g. the match scorecard) and focus it — focus alone would leave it
      // sitting on whatever page it was already showing.
      for (const client of clients) {
        if (new URL(client.url).pathname === target.pathname) {
          const go = "navigate" in client
            ? Promise.resolve(client.navigate(target.href)).catch(() => client)
            : Promise.resolve(client);
          return go.then((c) => (c || client).focus());
        }
      }
      // Otherwise open a fresh window straight to the target URL.
      return self.clients.openWindow(target.href);
    })
  );
});
