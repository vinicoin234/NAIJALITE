// NAIJALITE service worker - shows an "incoming call" notification when the app is closed.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Incoming call', body: event.data ? event.data.text() : '' };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Incoming call', {
      body: data.body || 'Tap to answer',
      icon: 'https://i.ibb.co/4gmXV5P8/PNG-1.jpg',
      tag: 'incoming-call',
      renotify: true,
      requireInteraction: true,
      vibrate: [300, 150, 300, 150, 300, 150, 300],
      data: { url: '/' }
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) {
          client.postMessage('check-calls'); // page then shows the ringing call
          return client.focus();
        }
      }
      return self.clients.openWindow('/');
    })
  );
});
