export default defineNuxtPlugin(() => {
  // Register service worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // SW registration failed silently
      })
    })
  }

  // Request notification permission on first visit
  if ('Notification' in window && Notification.permission === 'default') {
    // Wait for user interaction before asking
    const askPermission = () => {
      Notification.requestPermission().catch(() => {
        // Permission denied
      })
      document.removeEventListener('click', askPermission)
      document.removeEventListener('touchstart', askPermission)
    }

    document.addEventListener('click', askPermission, { once: true })
    document.addEventListener('touchstart', askPermission, { once: true })
  }

  // Listen for messages from the service worker (push notifications)
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'new-posts') {
        // The app.vue will handle this via the API response already
        // But we can dispatch a custom event for other components
        window.dispatchEvent(new CustomEvent('cortana-new-posts', {
          detail: event.data.payload
        }))
      }
    })
  }
})

