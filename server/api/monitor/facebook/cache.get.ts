import { createHash } from 'node:crypto'
import { getStoredPosts } from '../../../utils/storage'

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

function cleanFacebookText(text = '') {
  return text
    .replace(/Ver más/gi, '')
    .replace(/Ver mas/gi, '')
    .replace(/Ver menos/gi, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')
}

function normalizeFacebookLink(link = '') {
  if (!link) return ''

  try {
    const url = new URL(link)
    url.hash = ''
    for (const key of Array.from(url.searchParams.keys())) {
      if (key.startsWith('__') || key === 'fbclid') {
        url.searchParams.delete(key)
      }
    }
    return url.toString()
  } catch {
    return link
  }
}

function createDisplayId(post: { link?: string; text?: string }, index: number) {
  const key = normalizeFacebookLink(post.link) || cleanFacebookText(post.text).slice(0, 160) || String(index)
  return `facebook-${createHash('sha1').update(key).digest('hex')}`
}

function inferMediaType(post: { mediaType?: string; link?: string; image?: string }) {
  if (post.mediaType === 'video') return 'video'
  const link = normalizeFacebookLink(post.link).toLowerCase()
  if (link.includes('/videos/') || link.includes('/reel/') || link.includes('/watch/')) return 'video'
  return post.image ? 'image' : 'text'
}

function isRecent(post: { detectedAt?: string; date?: string }) {
  const timestamp = Date.parse(post.detectedAt || post.date || '')
  return !Number.isNaN(timestamp) && Date.now() - timestamp <= 24 * 60 * 60 * 1000
}

export default defineEventHandler(async () => {
  const posts = (await getStoredPosts('facebook')).filter(isRecent)
  const items: DisplayItem[] = posts.slice(0, 80).map((post, index) => {
    const text = cleanFacebookText(post.text) || post.text

    return {
      id: createDisplayId(post, index),
      context: text.slice(0, 260),
      fullText: text,
      image: post.image,
      link: normalizeFacebookLink(post.link),
      mediaType: inferMediaType(post),
      createdAt: post.date || post.detectedAt,
      isNew: false
    }
  })

  return {
    items,
    source: 'facebook-cache',
    totalStored: posts.length,
    newDetected: 0,
    message: items.length ? `Mostrando ${items.length} publicación(es) guardada(s). Actualizando en segundo plano.` : ''
  }
})
