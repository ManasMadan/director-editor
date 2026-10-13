// Service worker for Web Push. Shows what apps/notifications sends ({ title, body, link,
// tag }) and opens the link, on this site only, when the notification is clicked.
self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    return;
  }
  if (typeof message.title !== "string") {
    return;
  }
  event.waitUntil(
    self.registration.showNotification(message.title, {
      body: typeof message.body === "string" ? message.body : undefined,
      tag: typeof message.tag === "string" ? message.tag : undefined,
      data: { link: typeof message.link === "string" ? message.link : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.link ?? "/", self.location.origin);
  if (url.origin !== self.location.origin) {
    return;
  }
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === url.origin);
      if (open) {
        return open.focus().then(() => open.navigate(url.href));
      }
      return self.clients.openWindow(url.href);
    }),
  );
});
