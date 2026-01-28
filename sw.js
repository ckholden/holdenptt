const CACHE_NAME = 'holdenptt-v6';
const ASSETS = [
    './',
    './index.html',
    './css/style.css',
    './js/config.js',
    './js/auth.js',
    './js/channels.js',
    './js/chat.js',
    './js/audio.js',
    './js/alerts.js',
    './js/recording.js',
    './js/fcm.js',
    './js/app.js'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// FCM push event — show notification when app is backgrounded/closed
self.addEventListener('push', (e) => {
    if (!e.data) return;

    let data;
    try {
        const payload = e.data.json();
        data = payload.data || {};
    } catch (err) {
        return;
    }

    if (data.type !== 'alert') return;

    const title = 'ALERT - Holden PTT';
    const options = {
        body: `Emergency alert from ${data.sender || 'Unknown'} on ${data.channel || 'channel'}`,
        tag: 'ptt-alert',
        requireInteraction: true,
        vibrate: [300, 100, 300, 100, 300],
        data: { channel: data.channel, type: 'alert' }
    };

    e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    const notifData = e.notification.data || {};

    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            // Focus existing window and send message
            for (const client of clientList) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    client.postMessage({ type: 'ALERT_TAP', channel: notifData.channel });
                    return client.focus();
                }
            }
            // Otherwise open a new window with alert hash
            const hash = notifData.channel ? `#alert=${notifData.channel}` : '';
            return clients.openWindow('./' + hash);
        })
    );
});

self.addEventListener('fetch', (e) => {
    // Network-first for API/Firebase calls, cache-first for app assets
    if (e.request.url.includes('firebasejs') || e.request.url.includes('firebaseio') || e.request.url.includes('googleapis')) {
        e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    } else {
        // Network-first for app assets so updates are always seen
        e.respondWith(
            fetch(e.request)
                .then((response) => {
                    // Cache the fresh response for offline use
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
                    return response;
                })
                .catch(() => caches.match(e.request))
        );
    }
});
