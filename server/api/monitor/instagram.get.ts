import { createHash } from 'node:crypto'
import { scrapeInstagramProfile } from '../../utils/instagramScraper'
import { addNewPosts, getStoredPosts } from '../../utils/storage'
import { instagramFallbackPosts } from '../../utils/instagramFallback'

type DisplayItem = {
  id: string
  context: string
  fullText?: string
  image?: string
  link: string
  mediaType: 'image' | 'video' | 'text'
  createdAt?: string
  isNew: boolean
}

type MonitorResponse = {
  items: DisplayItem[]
  source: 'instagram'
  totalStored: number
  newDetected: number
  message: string
}

type InstagramFallbackPost = {
  text: string
  image?: string
  date?: string
  link: string
  mediaType?: 'image' | 'video' | 'text'
}

const INSTAGRAM_CACHE_MS = 60000
const INSTAGRAM_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000
let cachedResponse: {
  profileUrl: string
  expiresAt: number
  data: MonitorResponse
} | null = null
let instagramRateLimitedUntil = 0

function cleanInstagramText(text = '') {
  return text.replace(/\s+/g, ' ').trim()
}

function normalizeInstagramLink(link = '') {
  if (!link) return ''

  try {
    const url = new URL(link)
    url.hash = ''
    for (const key of Array.from(url.searchParams.keys())) {
      if (key.startsWith('__') || key.startsWith('utm_') || key === 'igsh') {
        url.searchParams.delete(key)
      }
    }
    return url.toString()
  } catch {
    return link
  }
}

function proxifyInstagramImage(image?: string) {
  return image ? `/api/proxy/image?url=${encodeURIComponent(image)}` : undefined
}

function createDisplayId(post: { link?: string; text?: string }, index: number) {
  const key = normalizeInstagramLink(post.link) || cleanInstagramText(post.text).slice(0, 160) || String(index)
  return `instagram-${createHash('sha1').update(key).digest('hex')}`
}

function getPublicationKey(post: { link?: string; text?: string }) {
  return normalizeInstagramLink(post.link) || cleanInstagramText(post.text).slice(0, 180).toLowerCase()
}

function getColombiaDateParts(date = new Date()) {
  const colombiaTime = new Date(date.getTime() - 5 * 60 * 60 * 1000)
  return {
    year: colombiaTime.getUTCFullYear(),
    month: colombiaTime.getUTCMonth(),
    day: colombiaTime.getUTCDate(),
    hour: colombiaTime.getUTCHours()
  }
}

function getTodayWindowInColombia(now = new Date()) {
  const { year, month, day } = getColombiaDateParts(now)
  return {
    start: new Date(Date.UTC(year, month, day, 11, 0, 0, 0)),
    end: new Date(Date.UTC(year, month, day + 1, 5, 0, 0, 0))
  }
}

function isInsideTodayWindow(post: { detectedAt?: string; date?: string }) {
  const { hour } = getColombiaDateParts()
  if (hour < 6) return false

  const timestamp = Date.parse(post.date || post.detectedAt || '')
  if (Number.isNaN(timestamp)) return false

  const { start, end } = getTodayWindowInColombia()
  return timestamp >= start.getTime() && timestamp < end.getTime()
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const profileUrl = String(query.url || '').trim()
  const forceRefresh = query.refresh === '1' || query.refresh === 'true'

  if (!profileUrl) {
    throw createError({ statusCode: 400, statusMessage: 'Falta el link del perfil de Instagram.' })
  }

  try {
    const url = new URL(profileUrl)
    if (!url.hostname.includes('instagram.com')) {
      throw new Error()
    }
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'El link proporcionado no es una URL válida de Instagram.' })
  }

  const now = Date.now()

  if (cachedResponse?.profileUrl === profileUrl && instagramRateLimitedUntil > now) {
    return {
      ...cachedResponse.data,
      message: `Instagram esta limitando Vercel temporalmente. Mostrando cache reciente con ${cachedResponse.data.items.length} publicación(es).`
    }
  }

  if (!forceRefresh && cachedResponse?.profileUrl === profileUrl && cachedResponse.expiresAt > now) {
    return cachedResponse.data
  }

  const result = await scrapeInstagramProfile(profileUrl)
  if (result.error?.includes('429')) {
    instagramRateLimitedUntil = Date.now() + INSTAGRAM_RATE_LIMIT_BACKOFF_MS
  }
  const cleanedPosts = result.posts.map((post) => ({
    ...post,
    text: cleanInstagramText(post.text) || post.text,
    link: normalizeInstagramLink(post.link),
    date: post.date || new Date().toISOString(),
    mediaType: post.mediaType || (post.image ? 'image' : 'text')
  }))

  const newPosts = cleanedPosts.length ? await addNewPosts(cleanedPosts, 'instagram') : []
  const allPosts = await getStoredPosts('instagram')

  const seen = new Set<string>()
  const fallbackPosts = (instagramFallbackPosts as InstagramFallbackPost[]).map((post) => ({
    ...post,
    id: createDisplayId(post, 0),
    source: 'instagram' as const,
    detectedAt: post.date || new Date().toISOString(),
    notified: false
  }))
  const sourcePosts = allPosts.length ? allPosts : (cleanedPosts.length ? cleanedPosts : fallbackPosts).map((post) => ({
    ...post,
    id: createDisplayId(post, 0),
    source: 'instagram' as const,
    detectedAt: post.date || new Date().toISOString(),
    notified: false
  }))
  const todayPosts = sourcePosts.filter(isInsideTodayWindow)
  const postsForDisplay = todayPosts.length ? todayPosts : sourcePosts.slice(0, 24)
  const items: DisplayItem[] = postsForDisplay.filter((post) => {
    const key = getPublicationKey(post)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 80).map((post, index) => ({
    id: createDisplayId(post, index),
    context: cleanInstagramText(post.text) || post.text,
    fullText: cleanInstagramText(post.text) || post.text,
    image: proxifyInstagramImage(post.image),
    link: normalizeInstagramLink(post.link),
    mediaType: post.mediaType || (post.image ? 'image' : 'text'),
    createdAt: post.date || post.detectedAt,
    isNew: newPosts.some((np) => np.id === post.id)
  }))

  if (items.length === 0 && result.error && cachedResponse?.profileUrl === profileUrl) {
    return {
      ...cachedResponse.data,
      message: `Instagram esta limitando Vercel: ${result.error}. Mostrando cache reciente con ${cachedResponse.data.items.length} publicación(es).`
    }
  }

  const response: MonitorResponse = {
    items,
    source: 'instagram',
    totalStored: allPosts.length,
    newDetected: newPosts.length,
    message: result.error
      ? `Instagram no respondio completamente: ${result.error}. Mostrando ${items.length} publicación(es) disponibles desde respaldo.`
      : newPosts.length > 0
      ? `Se detectaron ${newPosts.length} publicación(es) nueva(s) en Instagram. Mostrando ${items.length} publicación(es) de hoy entre 6:00 a. m. y medianoche.`
      : `Mostrando ${items.length} publicación(es) de Instagram de hoy entre 6:00 a. m. y medianoche.`
  }

  if (items.length > 0) {
    cachedResponse = {
      profileUrl,
      expiresAt: Date.now() + INSTAGRAM_CACHE_MS,
      data: response
    }
  }

  return response
})
