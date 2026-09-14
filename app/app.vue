<script setup lang="ts">
type MonitorItem = {
  id: string
  title?: string
  context: string
  category?: string
  fullText?: string
  leadText?: string
  author?: string
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

const activeView = ref<'web'>('web')
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
const dailyPublishedXCount = ref(0)
const currentUser = ref<UserId>('1')
const notifications = ref<UserNotification[]>([])
const copiedLinkId = ref('')
const showNotificationPanel = ref(false)
const showCorrections = ref(false)
const suggestItem = ref<{ item: MonitorItem; source: 'facebook' | 'web' } | null>(null)
const suggestField = ref('category')
const suggestValue = ref('')
const suggestMode = ref<'choose' | 'error' | 'category'>('choose')
const postFilter = ref<'all' | 'new'>('all')
const loadingPhase = ref('Consultando Burbujapolitica.com...')
const toast = ref<{ title: string; body: string } | null>(null)
type ConnectionQuality = 'Excelente' | 'Buena' | 'Regular' | 'Baja' | 'Sin conexión'
const connectionQuality = ref<ConnectionQuality>('Regular')
const connectionLatency = ref<number | null>(null)
const connectionMessage = computed(() => connectionQuality.value === 'Sin conexión'
  ? 'Sin conexión. Mostrando publicaciones almacenadas.'
  : `Conexión ${connectionQuality.value.toLowerCase()} · Latencia con Cortana: ${connectionLatency.value === null ? 'midiendo' : `${connectionLatency.value} ms`}`)
let loadingPhaseTimer: ReturnType<typeof setInterval> | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null
let connectionInterval: ReturnType<typeof setInterval> | null = null
let auxiliaryInterval: ReturnType<typeof setInterval> | null = null
let lastWebRequestAt = 0
let lastAuxiliaryPollAt = 0
let candidateQuality: ConnectionQuality | null = null
let candidateQualityCount = 0

const LOCAL_POST_CACHE_DB = 'cortana-monitor-cache'
const LOCAL_POST_CACHE_STORE = 'posts'
const LOCAL_POST_CACHE_MAX_AGE = 36 * 60 * 60 * 1000

function openLocalPostCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(LOCAL_POST_CACHE_DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(LOCAL_POST_CACHE_STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function saveLocalPosts(source: 'web' | 'facebook', items: MonitorItem[]) {
  try {
    const database = await openLocalPostCache()
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(LOCAL_POST_CACHE_STORE, 'readwrite')
      transaction.objectStore(LOCAL_POST_CACHE_STORE).put({ items, savedAt: Date.now() }, source)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    database.close()
  } catch {
    // IndexedDB is an optimization; the server cache remains available.
  }
}

async function readLocalPosts(source: 'web' | 'facebook') {
  try {
    const database = await openLocalPostCache()
    const value = await new Promise<{ items?: MonitorItem[]; savedAt?: number } | undefined>((resolve, reject) => {
      const request = database.transaction(LOCAL_POST_CACHE_STORE).objectStore(LOCAL_POST_CACHE_STORE).get(source)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()
    if (!value?.items?.length || !value.savedAt || Date.now() - value.savedAt > LOCAL_POST_CACHE_MAX_AGE) return null
    return value.items
  } catch {
    return null
  }
}

function classifyConnection(latency: number, networkInformation?: { effectiveType?: string; rtt?: number }) {
  const effectiveType = networkInformation?.effectiveType
  if (effectiveType === 'slow-2g' || effectiveType === '2g') return 'Baja' as const
  if (latency < 150) return 'Excelente' as const
  if (latency < 400) return 'Buena' as const
  if (latency < 1000) return 'Regular' as const
  return 'Baja' as const
}

async function measureConnection() {
  if (!navigator.onLine) {
    connectionQuality.value = 'Sin conexión'
    connectionLatency.value = null
    candidateQuality = null
    candidateQualityCount = 0
    return
  }

  const startedAt = performance.now()
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 4500)
  try {
    // Measure the same-origin deployment without depending on an API route that
    // may be protected by Vercel's edge rules in some environments. The icon
    // is a tiny static resource and does not download publication data.
    await fetch('/icon.svg', {
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: 'image/svg+xml' }
    })
    const latency = Math.round(performance.now() - startedAt)
    const networkInformation = (navigator as Navigator & { connection?: { effectiveType?: string; rtt?: number } }).connection
    const nextQuality = classifyConnection(latency, networkInformation)
    connectionLatency.value = latency

    if (nextQuality === connectionQuality.value || connectionQuality.value === 'Sin conexión') {
      candidateQuality = nextQuality
      candidateQualityCount = 0
      connectionQuality.value = nextQuality
    } else if (candidateQuality === nextQuality) {
      candidateQualityCount += 1
      if (candidateQualityCount >= 2) {
        connectionQuality.value = nextQuality
        candidateQualityCount = 0
      }
    } else {
      candidateQuality = nextQuality
      candidateQualityCount = 1
    }
  } catch {
    connectionLatency.value = null
    if (candidateQuality === 'Baja') {
      candidateQualityCount += 1
    } else {
      candidateQuality = 'Baja'
      candidateQualityCount = 1
    }
    if (candidateQualityCount >= 2 || connectionQuality.value === 'Sin conexión') {
      connectionQuality.value = 'Baja'
      candidateQualityCount = 0
    }
  } finally {
    window.clearTimeout(timeout)
  }
}

function networkAllowsRequest(manual = false) {
  if (!navigator.onLine || connectionQuality.value === 'Sin conexión') return false
  if (!manual && connectionLatency.value === null) return false
  if (!manual && connectionQuality.value === 'Baja') return false
  return true
}

const loadingPhases = [
  'Consultando Burbujapolitica.com...',
  'Buscando publicaciones de hoy...',
  'Procesando publicaciones...',
  'Guardando nuevas publicaciones...'
]

const displayedWebsiteItems = computed(() => postFilter.value === 'new'
  ? websiteItems.value.filter((item) => item.isNew)
  : websiteItems.value)

const latestWebsiteItem = computed(() => websiteItems.value[0])
const currentDateLabel = computed(() => new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota',
  day: 'numeric',
  month: 'long',
  year: 'numeric'
}).format(new Date()))

function showReviewToast(title: string, body: string) {
  toast.value = { title, body }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 5000)
}

function startReviewVisuals() {
  loadingPhase.value = loadingPhases[0]
  let phase = 0
  if (loadingPhaseTimer) clearInterval(loadingPhaseTimer)
  loadingPhaseTimer = setInterval(() => {
    phase = Math.min(phase + 1, loadingPhases.length - 1)
    loadingPhase.value = loadingPhases[phase]
  }, 900)
}

function stopReviewVisuals() {
  if (loadingPhaseTimer) clearInterval(loadingPhaseTimer)
  loadingPhaseTimer = null
}

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
    suggestValue.value = suggestField.value === 'delete' ? 'Eliminar publicación' : ''
    return
  }

  suggestValue.value = suggestItem.value ? getCorrectionValue(suggestItem.value.item, suggestField.value) : ''
}

async function submitSuggestion() {
  if (!suggestItem.value || suggestMode.value === 'choose') return
  if (suggestMode.value === 'category' && !suggestValue.value.trim()) return
  if (suggestMode.value === 'error' && suggestField.value !== 'delete' && !suggestValue.value.trim()) return
  const { item, source } = suggestItem.value
  try {
    await $fetch('/api/corrections/create', {
      method: 'POST',
      body: {
        postId: item.id,
        source,
        field: suggestField.value,
        currentValue: getCorrectionValue(item, suggestField.value),
        suggestedValue: suggestValue.value.trim() || 'Eliminar publicación'
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

// All monitor sources are refreshed in the background so the dashboard stays current.
const lastFacebookSyncAt = ref(0)

function pollAuxiliary() {
  if (!networkAllowsRequest()) return
  const now = Date.now()
  if (connectionQuality.value === 'Regular' && now - lastAuxiliaryPollAt < 60_000) return
  lastAuxiliaryPollAt = now
  fetchCorrections()
  fetchPublishedX()
  fetchNotifications()
}

onMounted(async () => {
  const savedUser = window.localStorage.getItem('cortana-user-id')
  if (savedUser === '1' || savedUser === '2') currentUser.value = savedUser

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    installPrompt.value = event
  })

  window.addEventListener('offline', () => {
    connectionQuality.value = 'Sin conexión'
    connectionLatency.value = null
  })
  window.addEventListener('online', () => { measureConnection() })

  // Show cached data immediately, then synchronize only when the connection allows it.
  loadCachedPosts()
  await measureConnection()
  if (networkAllowsRequest()) await refreshAll(true)
  pollAuxiliary()
  auxiliaryInterval = setInterval(pollAuxiliary, 15000)
  connectionInterval = setInterval(measureConnection, 30000)
})

async function loadCachedPosts() {
  const localItems = await readLocalPosts('web')
  if (localItems?.length && !websiteItems.value.length) websiteItems.value = localItems

  if (!navigator.onLine) return

  try {
    const webCache = await $fetch<MonitorResponse>('/api/monitor/web/cache')

    // Do not replace a live response that arrived before the cache request.
    if (!syncing.value && !websiteItems.value.length && webCache.items?.length) {
      websiteItems.value = webCache.items
    }
  } catch {
    // The live request still runs if the cache is unavailable.
  }
}

onUnmounted(() => {
  if (auxiliaryInterval) clearInterval(auxiliaryInterval)
  if (connectionInterval) clearInterval(connectionInterval)
  if (loadingPhaseTimer) clearInterval(loadingPhaseTimer)
  if (toastTimer) clearTimeout(toastTimer)
})

async function fetchPublishedX() {
  try {
    const response = await $fetch<{ postIds: string[]; dailyCount: number }>('/api/published-x', {
      query: { _t: Date.now() },
      cache: 'no-store'
    })
    publishedXPostIds.value = response.postIds
    dailyPublishedXCount.value = response.dailyCount
  } catch {
    // Never keep stale visual status when MongoDB cannot be read.
    publishedXPostIds.value = []
    dailyPublishedXCount.value = 0
  }
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

async function sendNotification(message: string) {
  if (!message) return

  try {
    await $fetch('/api/notifications', {
      method: 'POST',
      body: { sender: currentUser.value, message }
    })
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
    await fetchPublishedX()
  } catch {}
}

async function refreshActiveView(silent = false) {
  await loadWebsitePosts(silent)
}

async function refreshAll(silent = false) {
  if (syncing.value) return
  if (!networkAllowsRequest(true)) {
    message.value = connectionMessage.value
    return
  }

  syncing.value = true
  startReviewVisuals()
  if (!silent) loading.value = true
  if (!silent) message.value = 'Consultando las publicaciones actuales de la web...'
  try {
    await loadWebsitePosts(silent)
    if (!silent) {
      showReviewToast(
        'Revisión completada',
        newCount.value > 0 ? `${newCount.value} publicación(es) nueva(s) encontrada(s)` : 'No hay publicaciones nuevas'
      )
    }
  } finally {
    stopReviewVisuals()
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

function imageUrl(image = '') {
  try {
    const hostname = new URL(image).hostname.toLowerCase()
    if (hostname.includes('facebook') || hostname.includes('fbcdn') || hostname.includes('scontent') || hostname.includes('fbsbx') || hostname.includes('burbujapolitica.com')) {
      return `/api/proxy/image?url=${encodeURIComponent(image)}`
    }
  } catch {}
  return image
}

function handleImageError(event: Event, originalImage = '') {
  const target = event.target as HTMLImageElement
  if (originalImage && target.src !== originalImage) {
    target.src = originalImage
    return
  }
  target.style.display = 'none'
}

async function loadFacebookPosts(silent = false) {
  if (!networkAllowsRequest(!silent)) return
  if (!silent) loading.value = true

  try {
    const response = await $fetch<MonitorResponse>('/api/monitor/facebook', {
      query: { url: FACEBOOK_URL, _t: Date.now() },
      cache: 'no-store'
    })

    facebookItems.value = response.items || []
    await saveLocalPosts('facebook', facebookItems.value)

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
  if (!networkAllowsRequest(!silent)) {
    if (!silent) message.value = connectionMessage.value
    return
  }

  // A manual click immediately after a completed review should reuse its result.
  if (Date.now() - lastWebRequestAt < 15_000 && websiteItems.value.length) {
    if (!silent) message.value = 'La revisión reciente sigue vigente. Mostrando datos almacenados.'
    return
  }

  lastWebRequestAt = Date.now()
  if (!silent) loading.value = true

  try {
    const response = await $fetch<MonitorResponse>('/api/monitor/web', {
      query: { url: WEBSITE_URL, _t: Date.now() },
      cache: 'no-store'
    })

    const receivedItems = response.items || []
    const webDayClosed = response.message?.includes('La jornada web está cerrada.')

    // A transient Vercel/serverless response can be empty while the source or
    // MongoDB is still warming up. Keep the visible list instead of making
    // the publications disappear; an explicit closed-day response may clear it.
    if (receivedItems.length || !websiteItems.value.length || webDayClosed) {
      websiteItems.value = receivedItems
    }
    await saveLocalPosts('web', websiteItems.value)

    message.value = response.message || ''

    newCount.value = response.newDetected || 0
    if (newCount.value > 0) {
      showNewBadge.value = true
      triggerNotification(
        'Nuevas publicaciones en la web',
        `${response.newDetected} nueva(s) publicación(es) en Burbuja Política.`
      )
      setTimeout(() => { showNewBadge.value = false }, 5000)
    }

    lastCheckedAt.value = new Date().toLocaleTimeString('es-CO')
  } catch {
    message.value = 'No se pudieron leer las publicaciones de la web. Intenta nuevamente en unos segundos.'
    lastCheckedAt.value = new Date().toLocaleTimeString('es-CO')
  } finally {
    if (!silent) loading.value = false
  }
}

function getLoadingText() {
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

async function copyLink(link = '', postId = '', title = '') {
  if (!link) return
  const textToCopy = `${title.trim()} ${link.trim()}`.trim()

  try {
    await navigator.clipboard.writeText(textToCopy)
  } catch {
    // Clipboard access can be denied by the browser outside a secure context.
    const textarea = document.createElement('textarea')
    textarea.value = textToCopy
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand('copy')
    textarea.remove()
    if (!copied) {
      message.value = 'No se pudo copiar el título y el enlace.'
      return
    }
  }

  if (postId) {
    try {
      await $fetch('/api/published-x', {
        method: 'POST',
        body: { postId }
      })
      await fetchPublishedX()
    } catch {
      message.value = 'Se copió el contenido, pero no se pudo marcar como publicado en X.'
    }
  }

  copiedLinkId.value = postId
  setTimeout(() => {
    if (copiedLinkId.value === postId) copiedLinkId.value = ''
  }, 1500)
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

function formatTime(isoOrLocale: string | undefined): string {
  if (!isoOrLocale) return 'Sin hora'
  const date = new Date(isoOrLocale)
  if (Number.isNaN(date.getTime())) return 'Sin hora'
  return date.toLocaleTimeString('es-CO', {
    timeZone: 'America/Bogota',
    hour: '2-digit',
    minute: '2-digit'
  })
}
</script>

<template>
  <div class="monitor-app min-h-screen bg-surface text-white antialiased">
    <!-- Background gradient -->
    <div class="fixed inset-0 pointer-events-none bg-gradient-to-br from-accent/20 via-transparent to-transparent" />

    <div class="relative z-10">
      <!-- Install Banner -->
      <div
        v-if="installPrompt"
        class="install-banner fixed bottom-5 left-1/2 z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2"
      >
        <div class="glass-card install-card flex items-center gap-4 p-4 md:p-5">
          <div class="flex-1">
            <p class="text-sm font-semibold text-white">Instala Cortana Monitor</p>
            <p class="text-xs text-muted">Acceso rápido desde tu pantalla de inicio</p>
          </div>
          <button class="btn-primary text-sm !px-3 !py-1.5" @click="installApp">
            Instalar
          </button>
          <button class="btn-ghost close-button text-sm !px-2" aria-label="Cerrar aviso" @click="installPrompt = null">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 6 12 12M18 6 6 18"/></svg>
          </button>
        </div>
      </div>

      <main class="monitor-shell mx-auto max-w-7xl px-4 py-5 md:px-8 md:py-8">
        <Transition name="toast-slide">
          <div v-if="toast" class="review-toast" role="status">
            <span class="toast-check">✓</span>
            <span><strong>{{ toast.title }}</strong><small>{{ toast.body }}</small></span>
          </div>
        </Transition>
        <!-- Header -->
        <header class="monitor-header mb-5">
          <div class="flex flex-col md:flex-row gap-4 md:items-end md:justify-between">
            <div class="space-y-2">
              <div class="brand-lockup"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3a7 7 0 0 0-4 12.75V19h8v-3.25A7 7 0 0 0 12 3Z"/><path d="M9 22h6M9 12h6M10 16h4"/></svg></span><span class="eyebrow">Media intelligence</span></div>
              <h1 class="text-3xl md:text-5xl font-bold tracking-tight">
                Cortana Monitor
              </h1>
              <p class="text-sm text-muted md:text-base">Monitoreo inteligente de publicaciones</p>
            </div>
<div class="flex flex-wrap items-center gap-3">
              <div class="header-status"><span class="status-dot" /><span><strong>Activo</strong><small>Sistema operativo</small></span></div>
              <div v-if="lastCheckedAt" class="header-last-check"><span class="header-label">Última revisión</span><strong>{{ lastCheckedAt }}</strong></div>
              <button
                class="btn-revisar review-cta whitespace-nowrap"
                :disabled="syncing"
                @click="refreshAll"
              >
                <svg v-if="syncing" class="button-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a9 9 0 1 1-6.36 2.64"/></svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 11a8 8 0 1 1-2.34-5.66"/><path d="M20 4v7h-7"/></svg>
                {{ syncing ? 'Revisando...' : (lastCheckedAt ? 'Revisar nuevamente' : 'Revisar') }}
              </button>
              <button class="btn-secondary whitespace-nowrap" @click="showNotificationPanel = true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>
                Notificar
              </button>
              <button
                v-if="installPrompt"
                class="btn-primary whitespace-nowrap"
                @click="installApp"
              >
                Instalar app
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
            <NotificationComposer
              @send="sendNotification"
              @cancel="showNotificationPanel = false"
            />
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
         <div class="status-strip mb-6">
           <span class="status-strip-item"><span class="status-dot" /> {{ syncing ? 'Sincronizando...' : 'Sistema activo' }}</span>
           <span class="status-strip-item" :title="connectionQuality === 'Sin conexión' ? 'No se realizan solicitudes mientras no haya conexión.' : 'Latencia medida únicamente contra el servidor de Cortana.'"><span class="status-dot" :class="connectionQuality === 'Sin conexión' ? 'status-dot-red' : 'status-dot-blue'" /> {{ connectionQuality }} · Cortana</span>
           <span class="status-strip-item status-strip-muted">Publicaciones web: {{ websiteItems.length }}</span>
           <span class="status-strip-item status-strip-muted">Publicadas en X hoy: {{ dailyPublishedXCount }}</span>
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



         <section class="metrics-grid mb-8" aria-label="Resumen del monitoreo">
           <div class="metric-card metric-card-primary"><div class="metric-top"><span>Publicaciones de hoy</span><span class="metric-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 5h14v14H5z"/><path d="M8 9h8M8 13h6M8 17h4"/></svg></span></div><strong>{{ websiteItems.length }}</strong><small><span class="metric-live-dot" /> Burbujapolitica.com</small></div>
           <div class="metric-card"><div class="metric-top"><span>Nuevas</span><span class="metric-icon metric-icon-green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 5v14M5 12h14"/></svg></span></div><strong>{{ newCount }}</strong><small>{{ newCount ? 'Desde la última revisión' : 'Sin novedades recientes' }}</small></div>
         </section>

         <!-- Tabs + Posts -->
         <div class="content-panel p-4 md:p-7">
           <!-- Section heading and filters -->
           <div class="section-heading mb-6">
             <div>
               <p class="section-kicker">Fuente monitoreada · Burbujapolitica.com</p>
               <h2>Publicaciones de hoy</h2>
               <p>{{ currentDateLabel }} <span class="heading-separator">·</span> {{ websiteItems.length }} publicaciones encontradas</p>
             </div>
             <div class="section-actions">
               <div class="glass-tabs">
                 <button class="glass-tab" :class="{ active: postFilter === 'all' }" @click="postFilter = 'all'">Todas</button>
                 <button class="glass-tab" :class="{ active: postFilter === 'new' }" @click="postFilter = 'new'">Nuevas <span v-if="newCount">{{ newCount }}</span></button>
               </div>
               <button class="btn-secondary refresh-button" :disabled="syncing" @click="refreshAll">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 11a8 8 0 1 1-2.34-5.66"/><path d="M20 4v7h-7"/></svg>
                 Actualizar
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
           <div v-if="loading" class="review-progress">
             <div class="progress-orbit"><span /><span /><span /></div>
             <div><strong>{{ loadingPhase }}</strong><p>La información se está sincronizando de forma segura.</p></div>
             <div class="progress-track"><span /></div>
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
                    :src="imageUrl(item.image)"
                    :alt="item.mediaType === 'video' ? 'Miniatura de video' : 'Imagen de publicación'"
                    loading="lazy"
                    decoding="async"
                    @error="handleImageError($event, item.image)"
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
            <div class="source-panel mt-8">
              <div><span class="section-kicker">Fuente monitoreada</span><strong>Burbujapolitica.com</strong><small><span class="status-dot status-dot-blue" /> Conectado</small></div>
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
            <div v-if="websiteItems.length === 0" class="empty-state">
              <div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 5h16v14H4z"/><path d="m7 9 3 3 2-2 5 5M7 16h10"/></svg></div>
              <h3>No hay publicaciones cargadas</h3>
              <p>Presiona “Revisar” para consultar las publicaciones de hoy en Burbujapolitica.com.</p>
              <button class="btn-revisar" :disabled="syncing" @click="refreshAll">Revisar publicaciones</button>
            </div>

            <div v-else-if="displayedWebsiteItems.length === 0" class="empty-state compact-empty">
              <div class="empty-state-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M5 5h14v14H5z"/><path d="M8 12h8"/></svg></div>
              <h3>No hay publicaciones nuevas</h3>
              <p>La última revisión no encontró novedades.</p>
            </div>

            <div v-else class="posts-grid">
              <article
                v-for="item in displayedWebsiteItems"
                :key="item.id"
                class="post-card post-card-web"
              >
                <div v-if="item.isNew" class="relative">
                  <span class="badge-new absolute top-3 left-3 z-10">NUEVO</span>
                </div>

                <div v-if="item.image" class="relative">
                  <img
                    class="post-image"
                    :src="imageUrl(item.image)"
                    alt="Imagen de publicación web"
                    loading="lazy"
                    decoding="async"
                    @error="handleImageError($event, item.image)"
                  >
                  <span v-if="item.category" class="category-pill category-pill-floating">{{ item.category }}</span>
                </div>
                <div v-else class="post-image-placeholder" aria-label="Sin imagen disponible">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 5h16v14H4z"/><path d="m7 15 3-3 2 2 2-2 3 3"/><circle cx="9" cy="9" r="1"/></svg>
                  <span>Sin imagen</span>
                </div>

                <div class="p-4 space-y-2">
                   <div class="post-meta-row"><span class="source-pill source-pill-ok">WEB</span><span v-if="item.category" class="post-category">{{ item.category }}</span><span class="post-time">{{ formatTime(item.createdAt) }}</span></div>

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
                    <p class="text-xs text-muted-dark"><span v-if="item.author">Por {{ item.author }} · </span>{{ formatDate(item.createdAt) || '' }}</p>
                   <p class="post-excerpt whitespace-pre-line text-sm text-muted leading-relaxed">{{ item.context }}</p>

                  <div class="flex flex-wrap items-center gap-2 mt-2">
                    <button
                       v-if="item.link && !isPublishedOnX(item.id)"
                       class="btn-primary text-xs !px-3 !py-1.5"
                         @click="copyLink(item.link, item.id, item.title)"
                      >
                       {{ copiedLinkId === item.id ? 'Título y enlace copiados' : 'Copiar título y enlace' }}
                     </button>

                     <button
                       v-else-if="isPublishedOnX(item.id)"
                       class="btn-secondary text-xs !px-3 !py-1.5"
                       @click="unmarkPublishedOnX(item.id)"
                     >
                       Desmarcar publicado
                     </button>

                    <button
                      class="ml-auto btn-secondary text-xs !px-3 !py-1"
                      @click="openSuggest(item, 'web')"
                    >
                      Corrigeme
                    </button>

                    <a v-if="item.link" :href="item.link" target="_blank" rel="noopener noreferrer" class="post-link">Ver publicación <span>→</span></a>
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
                Abrir sitio <span>→</span>
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
                <div v-if="suggestMode === 'category'">
                  <label class="block text-xs font-medium text-muted mb-1.5">Nueva categoría</label>
                  <select
                    v-model="suggestValue"
                    class="input-field text-sm !text-white !bg-white/20" style="color-scheme: dark"
                  >
                    <option value="" disabled>Seleccionar categoría...</option>
                    <option v-for="cat in CATEGORIES" :key="cat" :value="cat">{{ cat }}</option>
                  </select>
                </div>
                <div v-else-if="suggestField !== 'delete'">
                  <label class="block text-xs font-medium text-muted mb-1.5">
                    {{ suggestField === 'image' ? 'Nueva URL de imagen' : suggestField === 'title' ? 'Nuevo título' : 'Nuevo texto' }}
                  </label>
                  <textarea
                    v-model="suggestValue"
                    class="input-field min-h-24 resize-y text-sm"
                    :placeholder="suggestField === 'image' ? 'https://...' : 'Escribe el valor correcto...'"
                  />
                </div>
                <p v-else class="rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
                  Al aplicar esta corrección se eliminará la publicación de la base de datos.
                </p>
              </template>
            <div class="flex gap-3 justify-end pt-2">
              <button class="btn-secondary text-sm" @click="closeSuggest">Cancelar</button>
               <button
                 v-if="suggestMode !== 'choose'"
                 class="btn-primary text-sm"
                  :disabled="suggestMode === 'category' && !suggestValue.trim() || suggestMode === 'error' && suggestField !== 'delete' && !suggestValue.trim()"
                @click="submitSuggestion"
              >
                Enviar sugerencia
              </button>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <footer class="mt-8 text-center text-xs text-muted-dark">
            <p>Cortana Monitor <span>·</span> Monitoreo de publicaciones web</p>
            <p class="mt-1">Los datos se almacenan de forma segura.</p>
        </footer>
      </main>
    </div>
  </div>
</template>
