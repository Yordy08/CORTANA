 <script setup lang="ts">
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

const FACEBOOK_URL = 'https://www.facebook.com/BurbujadeCordoba'
const WEBSITE_URL = 'https://burbujapolitica.com/'
const INSTAGRAM_URL = 'https://www.instagram.com/burbujapolitica?utm_source=ig_web_button_share_sheet&igsh=ZDNlZDc0MzIxNw=='

const activeView = ref<'facebook' | 'web' | 'instagram'>('facebook')
const facebookItems = ref<MonitorItem[]>([])
const websiteItems = ref<MonitorItem[]>([])
const instagramItems = ref<MonitorItem[]>([])
const message = ref('')
const loading = ref(false)
const installPrompt = ref<Event | null>(null)
const showNewBadge = ref(false)
const newCount = ref(0)
const lastCheckedAt = ref('')
const copiedTextId = ref('')
const syncing = ref(false)

// Periodic checking
let checkInterval: ReturnType<typeof setInterval> | null = null
const AUTO_REFRESH_MS = 60000
const INSTAGRAM_REFRESH_MS = 5 * 60 * 1000
const lastInstagramFetchAt = ref(0)

onMounted(() => {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    installPrompt.value = event
  })

  // Restore cached items from session
  const savedFacebook = sessionStorage.getItem('cortana-facebook-items')
  if (savedFacebook) {
    facebookItems.value = JSON.parse(savedFacebook)
  }
  const savedWeb = sessionStorage.getItem('cortana-web-items')
  if (savedWeb) {
    websiteItems.value = JSON.parse(savedWeb)
  }
  const savedInstagram = sessionStorage.getItem('cortana-instagram-items')
  if (savedInstagram) {
    instagramItems.value = JSON.parse(savedInstagram)
  }
  lastInstagramFetchAt.value = Number(sessionStorage.getItem('cortana-instagram-checked-at') || 0)

  // Initial load
  refreshAll()

  // Auto-check Facebook and web every minute. Instagram is rate-limited heavily by Meta/Vercel.
  checkInterval = setInterval(() => {
    refreshAll(true)
  }, AUTO_REFRESH_MS)
})

onUnmounted(() => {
  if (checkInterval) clearInterval(checkInterval)
})

async function refreshActiveView(silent = false) {
  if (activeView.value === 'facebook') {
    await loadFacebookPosts(silent)
  } else if (activeView.value === 'web') {
    await loadWebsitePosts(silent)
  } else {
    await loadInstagramPosts(silent)
  }
}

async function refreshAll(silent = false) {
  if (syncing.value) return

  syncing.value = true
  if (!silent) loading.value = true

  try {
    const tasks = [loadFacebookPosts(true), loadWebsitePosts(true)]

    if (activeView.value === 'instagram') {
      tasks.push(loadInstagramPosts(true))
    }

    await Promise.all(tasks)
  } finally {
    syncing.value = false
    if (!silent) loading.value = false
  }
}

function cacheItems(source: string, items: MonitorItem[]) {
  sessionStorage.setItem(`cortana-${source}-items`, JSON.stringify(items))
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

function isInstagramMatchByWebLead(webItem: MonitorItem, instagramItem: MonitorItem) {
  const leadText = normalizePublicationText(webItem.leadText || '')
  const instagramText = normalizePublicationText(`${instagramItem.context} ${instagramItem.fullText || ''}`)

  if (!leadText || !instagramText) return false
  if (leadText.length >= 60 && instagramText.includes(leadText.slice(0, 140))) return true

  const leadWords = uniqueWords(getComparableWords(leadText))
  const instagramWords = uniqueWords(getComparableWords(instagramText))
  const sharedWords = countSharedWords(leadWords, instagramWords)

  return leadWords.length >= 8 && sharedWords / leadWords.length >= 0.72
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

function existsInInstagram(item: MonitorItem) {
  if (instagramItems.value.some((instagramItem) => isSamePublication(item, instagramItem))) return true

  const relatedWebItems = websiteItems.value.filter((webItem) => isSamePublication(item, webItem))
  return relatedWebItems.some((webItem) => (
    instagramItems.value.some((instagramItem) => isInstagramMatchByWebLead(webItem, instagramItem) || isSamePublication(webItem, instagramItem))
  ))
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
      query: { url: FACEBOOK_URL }
    })

    if (response.items?.length) {
      facebookItems.value = response.items
      cacheItems('facebook', response.items)
    }

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
      query: { url: WEBSITE_URL }
    })

    if (response.items?.length) {
      websiteItems.value = response.items
      cacheItems('web', response.items)
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

async function loadInstagramPosts(silent = false) {
  if (silent && instagramItems.value.length > 0 && Date.now() - lastInstagramFetchAt.value < INSTAGRAM_REFRESH_MS) return
  if (!silent) loading.value = true

  try {
    const response = await $fetch<MonitorResponse>('/api/monitor/instagram', {
      query: { url: INSTAGRAM_URL, refresh: !silent ? '1' : undefined }
    })

    if (response.items?.length) {
      instagramItems.value = response.items
      cacheItems('instagram', response.items)
    }

    lastInstagramFetchAt.value = Date.now()
    sessionStorage.setItem('cortana-instagram-checked-at', String(lastInstagramFetchAt.value))

    message.value = response.message || ''

    if (response.newDetected && response.newDetected > 0) {
      newCount.value = response.newDetected
      showNewBadge.value = true
      triggerNotification(
        'Nuevas publicaciones en Instagram',
        `${response.newDetected} nueva(s) publicación(es) en Burbuja Política.`
      )
      setTimeout(() => { showNewBadge.value = false }, 5000)
    }

    lastCheckedAt.value = new Date().toLocaleTimeString('es-CO')
  } catch {
    if (!silent) message.value = 'No se pudieron obtener las publicaciones de Instagram.'
  } finally {
    if (!silent) loading.value = false
  }
}

function getLoadingText() {
  if (activeView.value === 'facebook') return 'Consultando publicaciones de Facebook...'
  if (activeView.value === 'web') return 'Leyendo publicaciones de la web...'
  return 'Consultando publicaciones de Instagram...'
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

async function copyLink(link = '') {
  if (!link) return
  try {
    await navigator.clipboard.writeText(link)
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

async function copyPostText(item: MonitorItem) {
  const text = (item.fullText || item.context)?.trim()
  if (!text) return

  try {
    await navigator.clipboard.writeText(text)
    copiedTextId.value = item.id
    setTimeout(() => {
      if (copiedTextId.value === item.id) copiedTextId.value = ''
    }, 1400)
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
              <span class="eyebrow">PWA de monitoreo</span>
              <h1 class="text-3xl md:text-4xl font-bold tracking-tight">
                Cortana Monitor
              </h1>
              <p class="text-muted max-w-xl">
                Monitorea automáticamente <strong class="text-white">Burbuja de Córdoba</strong> en Facebook,
                <strong class="text-white">Burbuja Política</strong> en la web e Instagram. Te notifica cuando hay nuevas publicaciones.
              </p>
            </div>
            <button
              v-if="installPrompt"
              class="btn-primary whitespace-nowrap"
              @click="installApp"
            >
              📲 Instalar app
            </button>
          </div>
        </header>

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
            {{ syncing ? 'Sincronizando...' : 'Autoactualiza cada 60s' }}
          </span>
          <span v-if="newCount > 0" class="badge-new">
            {{ newCount }} {{ newCount === 1 ? 'nueva' : 'nuevas' }}
          </span>
        </div>

        <!-- URL Panel -->
        <div class="glass-card p-5 md:p-6 mb-6">
          <div class="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end">
            <div>
              <label class="block text-xs font-medium text-muted mb-1.5">Facebook monitoreado</label>
              <input
                :value="FACEBOOK_URL"
                class="input-field text-sm"
                readonly
              >
            </div>
            <div>
              <label class="block text-xs font-medium text-muted mb-1.5">Web monitoreada</label>
              <input
                :value="WEBSITE_URL"
                class="input-field text-sm"
                readonly
              >
            </div>
            <div>
              <label class="block text-xs font-medium text-muted mb-1.5">Instagram monitoreado</label>
              <input
                :value="INSTAGRAM_URL"
                class="input-field text-sm"
                readonly
              >
            </div>
            <button
              class="btn-primary w-full md:w-auto"
              :disabled="loading"
              @click="refreshAll()"
            >
              {{ loading ? 'Revisando...' : 'Revisar' }}
            </button>
          </div>
        </div>

        <!-- Tabs + Posts -->
        <div class="glass-card p-5 md:p-6">
          <!-- Tab bar -->
          <div class="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between mb-6">
            <div class="glass-tabs">
              <button
                class="glass-tab"
                :class="{ active: activeView === 'facebook' }"
                @click="activeView = 'facebook'; refreshActiveView(true)"
              >
                Facebook
              </button>
              <button
                class="glass-tab"
                :class="{ active: activeView === 'web' }"
                @click="activeView = 'web'; refreshActiveView(true)"
              >
                Web
              </button>
              <button
                class="glass-tab"
                :class="{ active: activeView === 'instagram' }"
                @click="activeView = 'instagram'; refreshActiveView(true)"
              >
                Instagram
              </button>
            </div>

            <button
              class="btn-secondary text-sm"
              :disabled="loading"
              @click="refreshActiveView()"
            >
              {{ loading ? 'Cargando...' : '↻ Actualizar' }}
            </button>
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
                    <span class="video-badge">VIDEO</span>
                  </div>
                </div>

                <div v-else-if="item.mediaType === 'video'" class="video-placeholder">
                  <span class="video-badge">VIDEO</span>
                  <span class="text-xs text-white/60">Publicación con video</span>
                </div>

                <div class="p-4 space-y-2">
                  <div class="source-buttons">
                    <span class="source-pill source-pill-ok">Facebook</span>
                    <span class="source-pill" :class="existsInWeb(item) ? 'source-pill-ok' : 'source-pill-missing'">WEB</span>
                    <span class="source-pill" :class="existsInInstagram(item) ? 'source-pill-ok' : 'source-pill-missing'">Instagram</span>
                  </div>

                  <p class="text-xs text-muted-dark">
                    {{ formatDate(item.createdAt) || 'Publicación reciente' }}
                  </p>
                  <p class="whitespace-pre-line text-sm leading-relaxed">{{ item.context }}</p>

                  <button
                    class="btn-secondary text-xs !px-3 !py-1.5 mt-2"
                    type="button"
                    @click="copyPostText(item)"
                  >
                    {{ copiedTextId === item.id ? 'Texto copiado' : 'Copiar texto' }}
                  </button>

                  <a
                    v-if="item.link && isFacebookUrl(item.link)"
                    :href="item.link"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1 text-xs text-accent-light hover:text-accent mt-2 transition-colors"
                  >
                    Abrir en Facebook →
                  </a>

                  <a
                    v-else-if="item.link && isWebsiteUrl(item.link)"
                    :href="item.link"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1 text-xs text-accent-light hover:text-accent mt-2 transition-colors"
                  >
                    Ver noticia en web →
                  </a>
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
                    :src="item.image"
                    alt="Imagen de publicación web"
                    loading="lazy"
                  >
                  <span v-if="item.category" class="category-pill category-pill-floating">{{ item.category }}</span>
                </div>

                <div class="p-4 space-y-2">
                  <div class="source-buttons">
                    <span class="source-pill source-pill-ok">WEB</span>
                    <span class="source-pill" :class="existsInFacebook(item) ? 'source-pill-ok' : 'source-pill-missing'">Facebook</span>
                    <span class="source-pill" :class="existsInInstagram(item) ? 'source-pill-ok' : 'source-pill-missing'">Instagram</span>
                  </div>

                  <span v-if="item.category && !item.image" class="category-pill">{{ item.category }}</span>

                  <h3 class="font-semibold text-sm leading-snug">{{ item.title || 'Publicación web' }}</h3>
                  <p class="text-xs text-muted-dark">
                    {{ formatDate(item.createdAt) || '' }}
                  </p>
                  <p class="whitespace-pre-line text-sm text-muted leading-relaxed">{{ item.context }}</p>

                  <button
                    v-if="item.link"
                    class="btn-primary text-xs !px-3 !py-1.5 mt-2"
                    @click="copyLink(item.link)"
                  >
                    Copiar enlace
                  </button>
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

          <!-- Instagram Posts -->
          <template v-else>
            <div v-if="instagramItems.length === 0" class="py-12 text-center text-muted">
              <p class="text-lg mb-2">No hay publicaciones aún</p>
              <p class="text-sm text-muted-dark">Presiona "Revisar" para consultar Instagram.</p>
            </div>

            <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <article
                v-for="item in instagramItems"
                :key="item.id"
                class="post-card"
                :class="{ 'post-card-video': item.mediaType === 'video' }"
              >
                <div v-if="item.isNew" class="relative">
                  <span class="badge-new absolute top-3 left-3 z-10">NUEVO</span>
                </div>

                <div v-if="item.image" class="relative">
                  <img
                    class="post-image"
                    :class="{ 'video-media': item.mediaType === 'video' }"
                    :src="item.image"
                    :alt="item.mediaType === 'video' ? 'Miniatura de video en Instagram' : 'Imagen de publicación en Instagram'"
                    loading="lazy"
                  >
                  <div v-if="item.mediaType === 'video'" class="video-overlay">
                    <span class="video-badge">VIDEO</span>
                  </div>
                </div>

                <div v-else-if="item.mediaType === 'video'" class="video-placeholder">
                  <span class="video-badge">VIDEO</span>
                  <span class="text-xs text-white/60">Publicación con video</span>
                </div>

                <div class="p-4 space-y-2">
                  <div class="source-buttons">
                    <span class="source-pill source-pill-ok">Instagram</span>
                    <span class="source-pill" :class="existsInWeb(item) ? 'source-pill-ok' : 'source-pill-missing'">WEB</span>
                    <span class="source-pill" :class="existsInFacebook(item) ? 'source-pill-ok' : 'source-pill-missing'">Facebook</span>
                  </div>

                  <p class="text-xs text-muted-dark">
                    {{ formatDate(item.createdAt) || 'Publicación reciente' }}
                  </p>
                  <p class="whitespace-pre-line text-sm leading-relaxed">{{ item.context }}</p>

                  <button
                    class="btn-secondary text-xs !px-3 !py-1.5 mt-2"
                    type="button"
                    @click="copyPostText(item)"
                  >
                    {{ copiedTextId === item.id ? 'Texto copiado' : 'Copiar texto' }}
                  </button>

                  <a
                    v-if="item.link"
                    :href="item.link"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-1 text-xs text-accent-light hover:text-accent mt-2 transition-colors"
                  >
                    Abrir en Instagram →
                  </a>
                </div>
              </article>
            </div>

            <div class="mt-6 pt-4 border-t border-white/10 text-center">
              <a
                :href="INSTAGRAM_URL"
                target="_blank"
                rel="noopener noreferrer"
                class="btn-ghost text-sm"
              >
                Abrir Burbuja Política en Instagram →
              </a>
            </div>
          </template>
        </div>

        <!-- Footer -->
        <footer class="mt-8 text-center text-xs text-muted-dark">
          <p>Cortana Monitor v2 &mdash; Scraper headless con Playwright</p>
          <p class="mt-1">Los datos se almacenan localmente en el servidor.</p>
        </footer>
      </main>
    </div>
  </div>
</template>
