op <script setup lang="ts">
type MonitorItem = {
  id: string
  title?: string
  context: string
  category?: string
  fullText?: string
  leadText?: string
  image?: string
  link?: string
  createdAt?: string
  isNew?: boolean
  mediaType?: 'image' | 'video' | 'text'
}

type MonitorResponse = {
  items: MonitorItem[]
  source?: string
  message?: string
  totalStored?: number
  newDetected?: number
}

type Correction = {
  id: string
  postId: string
  source: 'facebook' | 'web'
  field: string
  currentValue?: string
  suggestedValue: string
  status: 'pending' | 'done'
  createdAt: string
}

type UserId = '1' | '2'

type UserNotification = {
  id: string
  sender: UserId
  recipient: UserId
  message: string
  createdAt: string
  readAt?: string
  recipientAcknowledgedAt?: string
  senderAcknowledgedAt?: string
}

const FACEBOOK_URL = 'https://www.facebook.com/BurbujadeCordoba'
const WEBSITE_URL = 'https://burbujapolitica.com/'

const activeView = ref<'facebook' | 'web'>('web')
const facebookEmbedUrl = ref('https://m.facebook.com')
const fbIframe = ref<HTMLIFrameElement | null>(null)

function reloadIframe() {
  if (fbIframe.value) {
    const currentSrc = facebookEmbedUrl.value
    fbIframe.value.src = ''
    setTimeout(() => {
      if (fbIframe.value) fbIframe.value.src = currentSrc
    }, 50)
  }
}
const facebookItems = ref<MonitorItem[]>([])
const websiteItems = ref<MonitorItem[]>([])
const message = ref('')
const loading = ref(false)
const installPrompt = ref<Event | null>(null)
const showNewBadge = ref(false)
const newCount = ref(0)
const lastCheckedAt = ref('')
const syncing = ref(false)
const corrections = ref<Correction[]>([])
const publishedXPostIds = ref<string[]>([])
const currentUser = ref<UserId>('1')
const notifications = ref<UserNotification[]>([])
const notificationMessage = ref('')
const showNotificationPanel = ref(false)
const showCorrections = ref(false)
const suggestItem = ref<{ item: MonitorItem; source: 'facebook' | 'web' } | null>(null)
const suggestField = ref('category')
const suggestValue = ref('')
const suggestMode = ref<'choose' | 'error' | 'category'>('choose')

const CATEGORIES = [
  'Ambiente',
  'Boletines',
  'Crónicas',
  'Ojo a los medios',
  'Opinión',
  'Política Córdoba',
  'Política Internacional',
  'Política Nación',
  'Política Región',
]

const CORRECTION_FIELDS = [
  { value: 'category', label: 'Categoría' },
  { value: 'title', label: 'Titular corrido' },
  { value: 'image', label: 'Imagen equivocada' },
  { value: 'text', label: 'Texto equivocado' },
  { value: 'delete', label: 'Eliminar publicación' }
]
const ERROR_FIELDS = CORRECTION_FIELDS.filter((field) => field.value !== 'category')

function correctionsFor(itemId: string) {
  return corrections.value.filter((c) => c.postId === itemId && c.status === 'pending')
}

async function fetchCorrections() {
  try {
    const res = await $fetch<{ corrections: Correction[] }>('/api/corrections/list', {
      query: { _t: Date.now() },
      cache: 'no-store'
    })
    // The server response is authoritative: an empty list means another
    // user already applied or resolved every pending correction.
    corrections.value = res.corrections
  } catch {}
}

function correctionPost(correction: Correction) {
  const items = correction.source === 'facebook' ? facebookItems.value : websiteItems.value
  return items.find((item) => item.id === correction.postId)
}

function openCorrections() {
  showCorrections.value = true
}

function closeCorrections() {
  showCorrections.value = false
}

function openSuggest(item: MonitorItem, source: 'facebook' | 'web') {
  suggestItem.value = { item, source }
  suggestMode.value = 'choose'
  suggestField.value = 'category'
  suggestValue.value = item.category || ''
}

function chooseSuggestMode(mode: 'error' | 'category') {
  suggestMode.value = mode
  suggestField.value = mode === 'category' ? 'category' : ERROR_FIELDS[0].value
  suggestValue.value = ''
  if (mode === 'error') changeSuggestField()
}

function closeSuggest() {
  suggestItem.value = null
  suggestMode.value = 'choose'
  suggestField.value = 'category'
  suggestValue.value = ''
}

function getCorrectionValue(item: MonitorItem, field: string) {
  if (field === 'category') return item.category || ''
  if (field === 'title') return item.title || ''
  if (field === 'image') return item.image || ''
  if (field === 'text') return item.fullText || item.context
  return ''
}

function changeSuggestField() {
  if (suggestMode.value === 'error') {
    suggestValue.value = ERROR_FIELDS.find((field) => field.value === suggestField.value)?.label || ''
    return
  }

  suggestValue.value = suggestItem.value ? getCorrectionValue(suggestItem.value.item, suggestField.value) : ''
}

async function submitSuggestion() {
  if (!suggestItem.value || (suggestMode.value === 'category' && !suggestValue.value.trim())) return
  const { item, source } = suggestItem.value
  try {
    await $fetch('/api/corrections/create', {
      method: 'POST',
      body: {
        postId: item.id,
        source,
        field: suggestField.value,
        currentValue: getCorrectionValue(item, suggestField.value),
        suggestedValue: suggestValue.value.trim() || 'Error reportado'
      }
    })
    await fetchCorrections()
    closeSuggest()
  } catch {}
}

async function applyCorrection(correctionId: string) {
  // Remove it immediately from both Apply buttons; the server also marks it
  // resolved so it will not return on the next polling cycle.
  corrections.value = corrections.value.filter((c) => c.id !== correctionId)
  if (corrections.value.length === 0) showCorrections.value = false

  try {
    const res = await $fetch('/api/corrections/resolve', {
      method: 'POST',
      body: { correctionId }
    }) as any
    const updatedPost = res.updatedPost as { id: string; category?: string } | undefined
    if (updatedPost?.id) {
      const field = res.correction?.field
      const value = res.correction?.suggestedValue
      let idx = facebookItems.value.findIndex((i) => i.id === updatedPost.id)
      if (idx !== -1) {
        if (field === 'delete') facebookItems.value.splice(idx, 1)
        else if (field === 'category') facebookItems.value[idx] = { ...facebookItems.value[idx], category: value }
      }
      idx = websiteItems.value.findIndex((i) => i.id === updatedPost.id)
      if (idx !== -1) {
        if (field === 'delete') websiteItems.value.splice(idx, 1)
        else if (field === 'category') websiteItems.value[idx] = { ...websiteItems.value[idx], category: value }
      }
    }
  } catch {}
}

// Periodic checking
let checkInterval: ReturnType<typeof setInterval> | null = null
let correctionInterval: ReturnType<typeof setInterval> | null = null
let publishedXInterval: ReturnType<typeof setInterval> | null = null
let notificationInterval: ReturnType<typeof setInterval> | null = null
// Keep the monitor responsive while avoiding overlapping scrapes.
const AUTO_REFRESH_MS = 5000
const FACEBOOK_REFRESH_MS = 15000
const lastFacebookSyncAt = ref(0)

onMounted(() => {
  const savedUser = window.localStorage.getItem('cortana-user-id')
  if (savedUser === '1' || savedUser === '2') currentUser.value = savedUser

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    installPrompt.value = event
  })

  // Render the last known posts immediately while the live monitor updates in
  // the background.
  loadCachedPosts()
  setTimeout(() => refreshAll(true), 0)
  fetchCorrections()
  correctionInterval = setInterval(fetchCorrections, 3000)
  fetchPublishedX()
  publishedXInterval = setInterval(fetchPublishedX, 3000)
  fetchNotifications()
  notificationInterval = setInterval(fetchNotifications, 3000)

  // Check the web frequently; Facebook remains on a less aggressive interval.
  checkInterval = setInterval(() => {
    refreshAll(true)
  }, AUTO_REFRESH_MS)
})

async function loadCachedPosts() {
  try {
    const [facebookCache, webCache] = await Promise.all([
      $fetch<MonitorResponse>('/api/monitor/facebook/cache'),
      $fetch<MonitorResponse>('/api/monitor/web/cache')
    ])

    // Do not replace a live response that arrived before the cache request.
    if (!facebookItems.value.length && facebookCache.items?.length) {
      facebookItems.value = facebookCache.items
    }
    if (!websiteItems.value.length && webCache.items?.length) {
      websiteItems.value = webCache.items
    }
  } catch {
    // The live request still runs if the cache is unavailable.
  }
}

onUnmounted(() => {
  if (checkInterval) clearInterval(checkInterval)
  if (correctionInterval) clearInterval(correctionInterval)
  if (publishedXInterval) clearInterval(publishedXInterval)
  if (notificationInterval) clearInterval(notificationInterval)
})

async function fetchPublishedX() {
  try {
    const response = await $fetch<{ postIds: string[] }>('/api/published-x', {
      query: { _t: Date.now() },
      cache: 'no-store'
    })
    publishedXPostIds.value = response.postIds
  } catch {}
}

function isPublishedOnX(postId: string) {
  return publishedXPostIds.value.includes(postId)
}

const pendingNotification = computed(() => notifications.value.find((notification) =>
  notification.recipient === currentUser.value && !notification.recipientAcknowledgedAt
))

const readNotification = computed(() => notifications.value.find((notification) =>
  notification.sender === currentUser.value && notification.readAt && !notification.senderAcknowledgedAt
))

function changeCurrentUser() {
  window.localStorage.setItem('cortana-user-id', currentUser.value)
  fetchNotifications()
}

async function fetchNotifications() {
  try {
    const response = await $fetch<{ notifications: UserNotification[] }>('/api/notifications', {
      query: { user: currentUser.value, _t: Date.now() },
      cache: 'no-store'
    })
    notifications.value = response.notifications
  } catch {}
}

async function sendNotification() {
  const message = notificationMessage.value.trim()
  if (!message) return

  try {
    await $fetch('/api/notifications', {
      method: 'POST',
      body: { sender: currentUser.value, message }
    })
    notificationMessage.value = ''
    showNotificationPanel.value = false
  } catch {}
}

async function acknowledgeNotification(notification: UserNotification) {
  // Close the alert immediately; synchronization continues in the background.
  notifications.value = notifications.value.filter((item) => item.id !== notification.id)

  try {
    const acknowledgingUser = notification.recipient === currentUser.value
      ? notification.recipient
      : notification.sender

    await $fetch('/api/notifications/ack', {
      method: 'POST',
      body: { id: notification.id, user: acknowledgingUser }
    })
  } catch {
    await fetchNotifications()
  }
}

async function unmarkPublishedOnX(postId: string) {
  if (!window.confirm('¿Desea desmarcar publicado en X?')) return

  try {
    await $fetch('/api/published-x', {
      method: 'DELETE',
      body: { postId }
    })
    publishedXPostIds.value = publishedXPostIds.value.filter((id) => id !== postId)
  } catch {}
}

async function refreshActiveView(silent = false) {
  if (activeView.value === 'facebook') {
    await loadFacebookPosts(silent)
  } else {
    await loadWebsitePosts(silent)
  }
}

async function refreshAll(silent = false) {
  if (syncing.value) return

  syncing.value = true
  if (!silent) loading.value = true

  try {
    const shouldRefreshFacebook = !silent
      || !facebookItems.value.length
      || Date.now() - lastFacebookSyncAt.value >= FACEBOOK_REFRESH_MS
    const tasks = [loadWebsitePosts(true)]

    if (shouldRefreshFacebook) tasks.push(loadFacebookPosts(true))

    await Promise.all(tasks)
  } finally {
    syncing.value = false
    if (!silent) loading.value = false
  }
}

const ignoredComparableWords = new Set([
  'para', 'pero', 'porque', 'por', 'con', 'una', 'uno', 'unos', 'unas', 'del', 'las', 'los', 'que', 'como', 'esta', 'este', 'estos', 'estas',
  'desde', 'sobre', 'tras', 'segun', 'entre', 'hacia', 'donde', 'cuando', 'durante', 'tambien', 'ademas', 'ante', 'bajo', 'cada', 'cual',
  'dijo', 'afirmo', 'explico', 'indico', 'senalo', 'informo', 'esto', 'esto', 'sera', 'fue', 'son', 'han', 'sus', 'sin', 'mas', 'menos'
])

function normalizePublicationText(value = '') {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getComparableWords(value = '') {
  return normalizePublicationText(value)
    .split(' ')
    .filter((word) => word.length > 3 && !ignoredComparableWords.has(word))
}

function getItemComparableText(item: MonitorItem) {
  return normalizePublicationText(`${item.title || ''} ${item.context} ${item.fullText || ''}`)
}

function uniqueWords(words: string[]) {
  return Array.from(new Set(words))
}

function countSharedWords(aWords: string[], bWords: string[]) {
  const bSet = new Set(bWords)
  return aWords.filter((word) => bSet.has(word)).length
}

function getWordChunks(words: string[], size: number) {
  const chunks = new Set<string>()
  for (let i = 0; i <= words.length - size; i++) {
    chunks.add(words.slice(i, i + size).join(' '))
  }
  return chunks
}

function hasSharedPhrase(aWords: string[], bWords: string[]) {
  const chunkSize = 4
  if (aWords.length < chunkSize || bWords.length < chunkSize) return false

  const aChunks = getWordChunks(aWords, chunkSize)
  return Array.from(getWordChunks(bWords, chunkSize)).some((chunk) => aChunks.has(chunk))
}

function isSamePublication(a: MonitorItem, b: MonitorItem) {
  const aText = getItemComparableText(a)
  const bText = getItemComparableText(b)

  if (!aText || !bText) return false
  if (aText.includes(bText.slice(0, 90)) || bText.includes(aText.slice(0, 90))) return true

  const aWords = uniqueWords(getComparableWords(aText))
  const bWords = uniqueWords(getComparableWords(bText))
  const smallestSetSize = Math.min(aWords.length, bWords.length)

  if (smallestSetSize < 6) return false

  const sharedWords = countSharedWords(aWords, bWords)
  const containmentRatio = sharedWords / smallestSetSize
  const jaccardRatio = sharedWords / new Set([...aWords, ...bWords]).size

  if (sharedWords >= 5 && containmentRatio >= 0.58) return true
  if (sharedWords >= 8 && containmentRatio >= 0.42) return true
  if (sharedWords >= 10 && jaccardRatio >= 0.22) return true

  const aStrongWords = aWords.filter((word) => word.length >= 6)
  const bStrongWords = bWords.filter((word) => word.length >= 6)
  const smallestStrongSetSize = Math.min(aStrongWords.length, bStrongWords.length)
  const sharedStrongWords = countSharedWords(aStrongWords, bStrongWords)

  if (smallestStrongSetSize >= 5 && sharedStrongWords >= 4 && sharedStrongWords / smallestStrongSetSize >= 0.45) return true
  return hasSharedPhrase(getComparableWords(aText), getComparableWords(bText))
}

function existsInWeb(item: MonitorItem) {
  return websiteItems.value.some((webItem) => isSamePublication(item, webItem))
}

function existsInFacebook(item: MonitorItem) {
  return facebookItems.value.some((facebookItem) => isSamePublication(item, facebookItem))
}

function isFacebookUrl(link = '') {
  try {
    const hostname = new URL(link).hostname.toLowerCase()
    return hostname.includes('facebook.com') || hostname.includes('fb.com')
  } catch {
    return false
  }
}

function isWebsiteUrl(link = '') {
  try {
    return new URL(link).hostname.toLowerCase().includes('burbujapolitica.com')
  } catch {
    return false
  }
}

async function loadFacebookPosts(silent = false) {
  if (!silent) loading.value = true

  try {
    const response = await $fetch<MonitorResponse>('/api/monitor/facebook', {
      query: { url: FACEBOOK_URL, _t: Date.now() },
      cache: 'no-store'
    })

    if (response.items?.length) {
      facebookItems.value = response.items
    }

    lastFacebookSyncAt.value = Date.now()

    message.value = response.message || ''

    if (response.newDetected && response.newDetected > 0) {
      newCount.value = response.newDetected
      showNewBadge.value = true
      triggerNotification(
        'Nuevas publicaciones en Facebook',
        `Se detectaron ${response.newDetected} publicación(es) nueva(s) en Burbuja de Córdoba.`
      )
      // Auto-hide badge after 5s
      setTimeout(() => { showNewBadge.value = false }, 5000)
    }

    lastCheckedAt.value = new Date().toLocaleTimeString('es-CO')
  } catch {
    if (!silent) message.value = 'No se pudieron obtener las publicaciones de Facebook.'
  } finally {
    if (!silent) loading.value = false
  }
}

async function loadWebsitePosts(silent = false) {
  if (!silent) loading.value = true

  try {
    const response = await $fetch<MonitorResponse>('/api/monitor/web', {
      query: { url: WEBSITE_URL, _t: Date.now() },
      cache: 'no-store'
    })

    if (response.items?.length) {
      websiteItems.value = response.items
    }

    message.value = response.message || ''

    if (response.newDetected && response.newDetected > 0) {
      newCount.value = response.newDetected
      showNewBadge.value = true
      triggerNotification(
        'Nuevas publicaciones en la web',
        `${response.newDetected} nueva(s) publicación(es) en Burbuja Política.`
      )
      setTimeout(() => { showNewBadge.value = false }, 5000)
    }

    lastCheckedAt.value = new Date().toLocaleTimeString('es-CO')
  } catch {
    if (!silent) message.value = 'No se pudieron leer las publicaciones de la web.'
  } finally {
    if (!silent) loading.value = false
  }
}

function getLoadingText() {
  if (activeView.value === 'facebook') return 'Consultando publicaciones de Facebook...'
  return 'Leyendo publicaciones de la web...'
}

function triggerNotification(title: string, body: string) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, {
      body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'cortana-new-posts'
    })
  }
}

async function copyLink(link = '', title = '', postId = '') {
  if (!link) return
  try {
    const text = title ? `${title}\n${link}` : link
    await navigator.clipboard.writeText(text)
    if (postId) {
      await $fetch('/api/published-x', {
        method: 'POST',
        body: { postId }
      })
      if (!publishedXPostIds.value.includes(postId)) {
        publishedXPostIds.value = [postId, ...publishedXPostIds.value]
      }
    }
    // Brief visual feedback via the button text
    const btn = document.activeElement
    if (btn) {
      const original = btn.textContent
      btn.textContent = 'Copiado ✓'
      setTimeout(() => { if (btn) btn.textContent = original }, 1200)
    }
  } catch {
    // ignore
  }
}

async function installApp() {
  const prompt = installPrompt.value as (Event & { prompt?: () => Promise<void> }) | null
  await prompt?.prompt?.()
  installPrompt.value = null
}

function formatDate(isoOrLocale: string | undefined): string {
  if (!isoOrLocale) return ''
  try {
    const date = new Date(isoOrLocale)
    if (!isNaN(date.getTime())) {
      return date.toLocaleDateString('es-CO', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    }
  } catch {
    // ignore
  }
  return isoOrLocale
}
</script>

<template>
  <div class="min-h-screen bg-surface text-white antialiased">
    <!-- Background gradient -->
    <div class="fixed inset-0 pointer-events-none bg-gradient-to-br from-accent/20 via-transparent to-transparent" />

    <div class="relative z-10">
      <!-- Install Banner -->
      <div
        v-if="installPrompt"
        class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-md"
      >
        <div class="glass-card p-4 flex items-center gap-3">
          <div class="flex-1">
            <p class="text-sm font-medium">Instalar Cortana Monitor</p>
            <p class="text-xs text-muted">Acceso rápido desde tu pantalla de inicio</p>
          </div>
          <button class="btn-primary text-sm !px-3 !py-1.5" @click="installApp">
            Instalar
          </button>
          <button class="btn-ghost text-sm !px-2" @click="installPrompt = null">
            ✕
          </button>
        </div>
      </div>

      <main class="mx-auto max-w-4xl px-4 py-6 md:py-10">
        <!-- Header -->
        <header class="glass-card p-6 md:p-8 mb-6 hero-gradient">
          <div class="flex flex-col md:flex-row gap-4 md:items-end md:justify-between">
            <div class="space-y-3">
              <h1 class="text-3xl md:text-4xl font-bold tracking-tight">
                Cortana Monitor
              </h1>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <button class="btn-secondary whitespace-nowrap" @click="showNotificationPanel = true">
                Notificar
              </button>
              <button
                v-if="installPrompt"
                class="btn-primary whitespace-nowrap"
                @click="installApp"
              >
                📲 Instalar app
              </button>
            </div>
          </div>
        </header>

        <!-- Notification composer -->
        <div
          v-if="showNotificationPanel"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          @click.self="showNotificationPanel = false"
        >
          <div class="glass-card w-full max-w-md space-y-4 p-6">
            <div class="flex items-center justify-between">
              <h3 class="text-lg font-semibold">Enviar notificación</h3>
              <button class="text-muted hover:text-white text-xl" @click="showNotificationPanel = false">✕</button>
            </div>
            <textarea
              v-model="notificationMessage"
              class="input-field min-h-28 resize-y text-sm"
              placeholder="Escribe un mensaje..."
              maxlength="500"
            />
            <div class="flex justify-end gap-3">
              <button class="btn-secondary text-sm" @click="showNotificationPanel = false">Cancelar</button>
              <button class="btn-primary text-sm" :disabled="!notificationMessage.trim()" @click="sendNotification">
                Enviar
              </button>
            </div>
          </div>
        </div>

        <!-- Incoming notification alert -->
        <div
          v-if="pendingNotification"
          class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
        >
          <div class="glass-card w-full max-w-md space-y-4 border-accent/40 p-6">
            <h3 class="text-lg font-semibold">Nueva notificación</h3>
            <p class="whitespace-pre-line rounded-xl bg-white/10 p-4 text-sm leading-relaxed">
              {{ pendingNotification.message }}
            </p>
            <div class="flex justify-end">
              <button class="btn-primary" @click="acknowledgeNotification(pendingNotification)">OK</button>
            </div>
          </div>
        </div>

        <!-- Read confirmation alert -->
        <div
          v-else-if="readNotification"
          class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
        >
          <div class="glass-card w-full max-w-md space-y-4 border-green-400/40 p-6">
            <h3 class="text-lg font-semibold text-green-300">Mensaje leído</h3>
            <p class="text-sm text-muted">
              Tu mensaje fue leído.
            </p>
            <div class="flex justify-end">
              <button class="btn-primary" @click="acknowledgeNotification(readNotification)">OK</button>
            </div>
          </div>
        </div>

         <!-- Status Bar -->
        <div class="flex flex-wrap items-center gap-3 mb-6 text-sm text-muted">
          <span class="inline-flex items-center gap-1.5">
            <span class="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
            Activo
          </span>
          <span v-if="lastCheckedAt" class="text-muted-dark">
            Última revisión: {{ lastCheckedAt }}
          </span>
          <span class="inline-flex items-center gap-1.5 text-accent-light">
            <span class="h-2 w-2 rounded-full" :class="syncing ? 'bg-blue-300 animate-ping' : 'bg-blue-400'" />
             {{ syncing ? 'Sincronizando...' : 'Autoactualiza cada 15s' }}
          </span>
          <span v-if="newCount > 0" class="badge-new">
            {{ newCount }} {{ newCount === 1 ? 'nueva' : 'nuevas' }}
          </span>
          <span
            v-if="corrections.length > 0"
             class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-yellow-500/20 text-yellow-300 text-xs font-semibold ring-1 ring-yellow-400/30 cursor-pointer hover:bg-yellow-500/30"
             role="button"
             tabindex="0"
             @click="openCorrections"
             @keyup.enter="openCorrections"
           >
             {{ corrections.length }} {{ corrections.length === 1 ? 'corrección pendiente' : 'correcciones pendientes' }}
          </span>
        </div>



        <!-- Tabs + Posts -->
        <div class="glass-card p-5 md:p-6">
          <!-- Tab bar -->
          <div class="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between mb-6">
            <div class="glass-tabs">
              <button
                class="glass-tab"
                :class="{ active: activeView === 'web' }"
                 @click="activeView = 'web'"
              >
                Web
              </button>
              <button
                class="glass-tab"
                :class="{ active: activeView === 'facebook' }"
                 @click="activeView = 'facebook'"
              >
                Facebook
              </button>

            </div>

          </div>

          <!-- Message -->
          <div
            v-if="message && !loading"
            class="mb-5 px-4 py-3 rounded-xl bg-accent/10 border border-accent/20 text-sm text-accent-light"
          >
            {{ message }}
          </div>

          <!-- Loading -->
          <div v-if="loading" class="loading-spinner">
            {{ getLoadingText() }}
          </div>

          <!-- Facebook Posts -->
          <template v-else-if="activeView === 'facebook'">
            <div v-if="facebookItems.length === 0" class="py-12 text-center text-muted">
              <p class="text-lg mb-2">No hay publicaciones aún</p>
              <p class="text-sm text-muted-dark">Presiona "Revisar" para consultar las últimas publicaciones.</p>
            </div>

            <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <article
                v-for="item in facebookItems"
                :key="item.id"
                class="post-card"
                :class="{ 'post-card-video': item.mediaType === 'video' }"
              >
                <!-- Badge for new posts -->
                <div v-if="item.isNew" class="relative">
                  <span class="badge-new absolute top-3 left-3 z-10">NUEVO</span>
                </div>

                <div v-if="item.image" class="relative">
                  <img
                    class="post-image"
                    :class="{ 'video-media': item.mediaType === 'video' }"
                    :src="item.image"
                    :alt="item.mediaType === 'video' ? 'Miniatura de video' : 'Imagen de publicación'"
                    loading="lazy"
                  >
                  <div v-if="item.mediaType === 'video'" class="video-overlay">
                     <span class="video-badge">APAGADO · VIDEO</span>
                  </div>
                </div>

                <div v-else-if="item.mediaType === 'video'" class="video-placeholder">
                   <span class="video-badge">APAGADO · VIDEO</span>
                  <span class="text-xs text-white/60">Publicación con video</span>
                </div>

                <div class="p-4 space-y-2">
                  <div class="source-buttons">
                    <span class="source-pill source-pill-ok">Facebook</span>
                    <span class="source-pill" :class="existsInWeb(item) ? 'source-pill-ok' : 'source-pill-missing'">WEB</span>
                  </div>

                  <div v-if="correctionsFor(item.id).length" class="flex flex-wrap gap-2">
                    <div
                      v-for="corr in correctionsFor(item.id)"
                      :key="corr.id"
                      class="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-yellow-500/15 border border-yellow-400/25 text-xs text-yellow-200"
                    >
                      <span>✏️ {{ corr.field }}: {{ corr.suggestedValue }}</span>
                      <button
                        class="ml-1 px-2 py-0.5 rounded-lg bg-green-500/20 text-green-300 hover:bg-green-500/30 font-semibold"
                        @click="applyCorrection(corr.id)"
                      >
                        Aplicar
                      </button>
                    </div>
                  </div>

                  <p class="text-xs text-muted-dark">
                    {{ formatDate(item.createdAt) || 'Publicación reciente' }}
                  </p>
                  <p class="whitespace-pre-line text-sm leading-relaxed">{{ item.context }}</p>

                  <div class="flex flex-wrap items-center gap-2 mt-2">
                    <a
                      v-if="item.link && isFacebookUrl(item.link)"
                      :href="item.link"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="inline-flex items-center gap-1 text-xs text-accent-light hover:text-accent transition-colors"
                    >
                      Abrir en Facebook →
                    </a>

                    <a
                      v-else-if="item.link && isWebsiteUrl(item.link)"
                      :href="item.link"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="inline-flex items-center gap-1 text-xs text-accent-light hover:text-accent transition-colors"
                    >
                      Ver noticia en web →
                    </a>

                  </div>
                </div>
              </article>
            </div>

            <!-- Quick link to open Facebook -->
            <div class="mt-6 pt-4 border-t border-white/10 text-center">
              <a
                :href="FACEBOOK_URL"
                target="_blank"
                rel="noopener noreferrer"
                class="btn-ghost text-sm"
              >
                Abrir Burbuja de Córdoba en Facebook →
              </a>
            </div>
          </template>

          <!-- Web Posts -->
          <template v-else-if="activeView === 'web'">
            <div v-if="websiteItems.length === 0" class="py-12 text-center text-muted">
              <p class="text-lg mb-2">No hay publicaciones aún</p>
              <p class="text-sm text-muted-dark">Presiona "Revisar" para consultar la web.</p>
            </div>

            <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <article
                v-for="item in websiteItems"
                :key="item.id"
                class="post-card"
              >
                <div v-if="item.isNew" class="relative">
                  <span class="badge-new absolute top-3 left-3 z-10">NUEVO</span>
                </div>

                <div v-if="item.image" class="relative">
                  <img
                    class="post-image"
                    :src="isWebsiteUrl(item.image) ? `/api/proxy/image?url=${encodeURIComponent(item.image)}` : item.image"
                    alt="Imagen de publicación web"
                    loading="lazy"
                  >
                  <span v-if="item.category" class="category-pill category-pill-floating">{{ item.category }}</span>
                </div>

                <div class="p-4 space-y-2">
                  <div class="source-buttons">
                    <span class="source-pill source-pill-ok">WEB</span>
                   <span class="source-pill" :class="existsInFacebook(item) ? 'source-pill-ok' : 'source-pill-waiting'">
                     {{ existsInFacebook(item) ? 'Facebook' : 'Facebook · esperando' }}
                   </span>
                  </div>

                  <div v-if="correctionsFor(item.id).length" class="flex flex-wrap gap-2">
                    <div
                      v-for="corr in correctionsFor(item.id)"
                      :key="corr.id"
                      class="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-yellow-500/15 border border-yellow-400/25 text-xs text-yellow-200"
                    >
                      <span>✏️ {{ corr.field }}: {{ corr.suggestedValue }}</span>
                      <button
                        class="ml-1 px-2 py-0.5 rounded-lg bg-green-500/20 text-green-300 hover:bg-green-500/30 font-semibold"
                        @click="applyCorrection(corr.id)"
                      >
                        Aplicar
                      </button>
                    </div>
                  </div>

                  <span v-if="item.category && !item.image" class="category-pill">{{ item.category }}</span>

                   <h3 class="font-semibold text-sm leading-snug">{{ item.title || 'Publicación web' }}</h3>
                   <p
                     v-if="isPublishedOnX(item.id)"
                     class="cursor-pointer text-sm font-semibold text-green-400 hover:text-green-300"
                     role="button"
                     tabindex="0"
                     @click="unmarkPublishedOnX(item.id)"
                     @keyup.enter="unmarkPublishedOnX(item.id)"
                   >
                     ✔️ | Publicado en X
                   </p>
                   <p class="text-xs text-muted-dark">
                    {{ formatDate(item.createdAt) || '' }}
                  </p>
                  <p class="whitespace-pre-line text-sm text-muted leading-relaxed">{{ item.context }}</p>

                  <div class="flex flex-wrap items-center gap-2 mt-2">
                    <button
                      v-if="item.link"
                      class="btn-primary text-xs !px-3 !py-1.5"
                      @click="copyLink(item.link, item.title || 'Publicación web', item.id)"
                    >
                      Copiar enlace
                    </button>

                    <button
                      class="ml-auto btn-secondary text-xs !px-3 !py-1"
                      @click="openSuggest(item, 'web')"
                    >
                      Corrigeme
                    </button>
                  </div>
                </div>
              </article>
            </div>

            <div class="mt-6 pt-4 border-t border-white/10 text-center">
              <a
                :href="WEBSITE_URL"
                target="_blank"
                rel="noopener noreferrer"
                class="btn-ghost text-sm"
              >
                Abrir Burbuja Política en la web →
              </a>
            </div>
          </template>

         </div>

         <!-- Pending corrections -->
         <div
           v-if="showCorrections"
           class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
           @click.self="closeCorrections"
         >
           <div class="glass-card p-6 w-full max-w-lg max-h-[85vh] overflow-y-auto space-y-4">
             <div class="flex items-center justify-between">
               <h3 class="text-lg font-semibold">Correcciones pendientes</h3>
               <button class="text-muted hover:text-white text-xl" @click="closeCorrections">✕</button>
             </div>
             <article
               v-for="correction in corrections"
               :key="correction.id"
               class="rounded-2xl border border-yellow-400/25 bg-yellow-500/10 p-4 space-y-2"
             >
               <div class="flex items-center justify-between gap-3 text-xs text-yellow-200">
                 <span>{{ correction.source === 'facebook' ? 'Facebook' : 'Web' }} · {{ correction.field }}</span>
                 <span>{{ formatDate(correction.createdAt) }}</span>
               </div>
               <p class="text-sm text-white/90">
                 {{ correctionPost(correction)?.context || 'La publicación ya no está cargada en la vista actual.' }}
               </p>
               <p class="text-xs text-yellow-200">
                 Sugerencia: <strong>{{ correction.suggestedValue }}</strong>
               </p>
               <div class="flex justify-end gap-2">
                 <button
                   class="btn-secondary text-xs !px-3 !py-1.5"
                   @click="activeView = correction.source === 'facebook' ? 'facebook' : 'web'; closeCorrections()"
                 >
                   Ver publicación
                 </button>
                 <button class="btn-primary text-xs !px-3 !py-1.5" @click="applyCorrection(correction.id)">
                   Aplicar
                 </button>
               </div>
             </article>
           </div>
         </div>

         <!-- Suggest Correction Modal -->
        <div
          v-if="suggestItem"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          @click.self="closeSuggest"
        >
          <div class="glass-card p-6 w-full max-w-md space-y-4">
            <div class="flex items-center justify-between">
              <h3 class="text-lg font-semibold">Sugerir corrección</h3>
              <button class="text-muted hover:text-white text-xl" @click="closeSuggest">✕</button>
            </div>
            <div class="space-y-1 text-sm text-muted">
              <p class="text-xs">Publicación:</p>
              <p class="text-white line-clamp-2">{{ suggestItem.item.context }}</p>
            </div>
             <div v-if="suggestMode === 'choose'" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
               <button class="btn-secondary min-h-20" @click="chooseSuggestMode('error')">
                 Hay un error
               </button>
               <button class="btn-primary min-h-20" @click="chooseSuggestMode('category')">
                 Cambiar categoría
               </button>
             </div>
             <template v-else>
               <div v-if="suggestMode === 'error'">
                 <label class="block text-xs font-medium text-muted mb-1.5">Tipo de error</label>
                 <select v-model="suggestField" class="input-field text-sm" @change="changeSuggestField">
                   <option v-for="field in ERROR_FIELDS" :key="field.value" :value="field.value">
                     {{ field.label }}
                   </option>
                 </select>
               </div>
               <div v-if="suggestMode === 'category' || suggestField === 'category'">
               <label class="block text-xs font-medium text-muted mb-1.5">Nueva categoría</label>
               <select
                v-model="suggestValue"
                class="input-field text-sm !text-white !bg-white/20" style="color-scheme: dark"
              >
                <option value="" disabled selected>Seleccionar categoría...</option>
                 <option v-for="cat in CATEGORIES" :key="cat" :value="cat">{{ cat }}</option>
               </select>
             </div>
             </template>
            <div class="flex gap-3 justify-end pt-2">
              <button class="btn-secondary text-sm" @click="closeSuggest">Cancelar</button>
               <button
                 v-if="suggestMode !== 'choose'"
                 class="btn-primary text-sm"
                  :disabled="suggestMode === 'category' && !suggestValue.trim()"
                @click="submitSuggestion"
              >
                Enviar sugerencia
              </button>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <footer class="mt-8 text-center text-xs text-muted-dark">
          <p>Cortana Monitor v2 &mdash; Monitor de Facebook y web</p>
          <p class="mt-1">Los datos se almacenan localmente en el servidor.</p>
        </footer>
      </main>
    </div>
  </div>
</template>
