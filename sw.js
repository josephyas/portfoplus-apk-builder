// Service Worker for Web Push Notifications + PWA installability

// Required fetch handler for PWA installability criteria
self.addEventListener("fetch", (event) => {
  // Network-first strategy — let the browser handle all requests normally
  event.respondWith(fetch(event.request))
})


self.addEventListener("push", (event) => {
  if (!event.data) return

  let payload
  try {
    payload = event.data.json()
  } catch {
    // Handle plain text push (e.g. from DevTools "Push" button)
    payload = { title: "پورتفو پلاس", body: event.data.text() }
  }

  const options = {
    body: payload.body || "",
    icon: payload.icon || "/icons/icon-192.png",
    badge: payload.badge || "/icons/icon-192.png",
    dir: "rtl",
    lang: "fa",
    data: payload.data || {},
    tag: payload.data?.id ? `notification-${payload.data.id}` : undefined,
  }

  event.waitUntil(self.registration.showNotification(payload.title, options))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()

  const data = event.notification.data || {}
  let url = "/app/notifications"

  if (data.recommendation_id) {
    url = `/app/signals/${data.recommendation_id}`
  } else if (data.url) {
    url = data.url
  }

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      // Focus existing window if available
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.focus()
          client.navigate(url)
          return
        }
      }
      // Otherwise open a new window
      return clients.openWindow(url)
    })
  )
})
