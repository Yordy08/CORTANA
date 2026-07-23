import { scrapeFacebookPage } from '../../utils/facebookScraper'
import { addNewPosts, getStoredPosts } from '../../utils/storage'
import { createHash } from 'node:crypto'

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

type WordPressPost = {
  id: number
  date?: string
  link?: string
  title?: { rendered?: string }
  excerpt?: { rendered?: string }
  content?: { rendered?: string }
  _embedded?: {
    'wp:featuredmedia'?: Array<{
      source_url?: string
      media_details?: { sizes?: Record<string, { source_url?: string }> }
    }>
  }
}

function cleanFacebookText(text = '') {
  const lines = text
    .replace(/Ver más/gi, '')
    .replace(/Ver mas/gi, '')
    .replace(/Ver menos/gi, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const seen = new Set<string>()

  const uniqueLines = lines.filter((line) => {
    const key = line.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  if (uniqueLines.length > 1) {
    const firstLine = uniqueLines[0]
    const rest = uniqueLines.slice(1)
    const restText = rest.join(' ')
    const firstLooksConcatenated = firstLine.length > 220 && rest.length >= 2
    const restRepeatsFirst = restText.slice(0, 80) && firstLine.toLowerCase().includes(restText.slice(0, 80).toLowerCase())

    if (firstLooksConcatenated || restRepeatsFirst) {
      return rest.join('\n\n')
    }
  }

  return uniqueLines.join('\n\n')
}

function cleanHtmlText(text = '') {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#8216;|&#8217;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8211;|&#8212;/g, '-')
    .replace(/&#8230;/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
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

function isFacebookCommentLink(link = '') {
  if (!link) return false

  try {
    const url = new URL(link)
    return url.searchParams.has('comment_id')
      || url.searchParams.has('reply_comment_id')
      || url.pathname.includes('/comments/')
  } catch {
    return link.includes('comment_id=') || link.includes('reply_comment_id=') || link.includes('/comments/')
  }
}

function createDisplayId(post: { link?: string; text?: string }, index: number) {
  const key = normalizeFacebookLink(post.link) || cleanFacebookText(post.text).slice(0, 160) || String(index)
  return `facebook-${createHash('sha1').update(key).digest('hex')}`
}

function inferMediaType(post: { mediaType?: string; link?: string; image?: string }) {
  if (post.mediaType === 'video') return 'video'
  const link = normalizeFacebookLink(post.link).toLowerCase()
  if (link.includes('/videos/') || link.includes('/watch/')) return 'video'
  return post.image ? 'image' : 'text'
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

  const timestamp = Date.parse(post.detectedAt || post.date || '')
  if (Number.isNaN(timestamp)) return false

  const { start, end } = getTodayWindowInColombia()
  return timestamp >= start.getTime() && timestamp < end.getTime()
}

function getPublicationKey(post: { link?: string; text?: string }) {
  return normalizeFacebookLink(post.link) || cleanFacebookText(post.text).slice(0, 180).toLowerCase()
}

function getTextKey(text = '') {
  return cleanHtmlText(cleanFacebookText(text) || text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110)
}

function getWordPressImage(post: WordPressPost) {
  const media = post._embedded?.['wp:featuredmedia']?.[0]
  return media?.media_details?.sizes?.large?.source_url
    || media?.media_details?.sizes?.medium_large?.source_url
    || media?.media_details?.sizes?.medium?.source_url
    || media?.source_url
}

async function fetchDailyWebItems(existingTextKeys: Set<string>): Promise<DisplayItem[]> {
  const apiUrl = new URL('https://burbujapolitica.com/wp-json/wp/v2/posts')
  apiUrl.searchParams.set('per_page', '50')
  apiUrl.searchParams.set('_embed', '1')

  const response = await fetch(apiUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0 CortanaMonitor/2.0',
      accept: 'application/json'
    },
    signal: AbortSignal.timeout(15000)
  })

  if (!response.ok) return []

  const posts = await response.json() as WordPressPost[]
  const { start, end } = getTodayWindowInColombia()
  const items: DisplayItem[] = []

  for (const post of posts) {
    const postTime = Date.parse(post.date || '')
    if (Number.isNaN(postTime) || postTime < start.getTime() || postTime >= end.getTime()) continue

    const title = cleanHtmlText(post.title?.rendered)
    const fullText = cleanHtmlText(post.content?.rendered || post.excerpt?.rendered)
    const excerpt = cleanHtmlText(post.excerpt?.rendered || post.content?.rendered).slice(0, 260)
    const context = title ? `${title}${excerpt ? `: ${excerpt}` : ''}` : excerpt
    const completeText = title ? `${title}${fullText ? `\n\n${fullText}` : ''}` : fullText
    const textKey = getTextKey(context)

    if (!context || existingTextKeys.has(textKey)) continue

    existingTextKeys.add(textKey)
    items.push({
      id: `facebook-web-${createHash('sha1').update(post.link || String(post.id)).digest('hex')}`,
      context,
      fullText: completeText || context,
      image: getWordPressImage(post),
      link: post.link || 'https://burbujapolitica.com/',
      mediaType: getWordPressImage(post) ? 'image' : 'text',
      createdAt: post.date,
      isNew: false
    })
  }

  return items
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const pageUrl = String(query.url || '').trim()

  if (!pageUrl) {
    throw createError({ statusCode: 400, statusMessage: 'Falta el link de la página de Facebook.' })
  }

  // Validate URL
  try {
    const url = new URL(pageUrl)
    if (!url.hostname.includes('facebook.com') && !url.hostname.includes('fb.com')) {
      throw new Error()
    }
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'El link proporcionado no es una URL válida de Facebook.' })
  }

  // Run the Playwright scraper
  const result = await scrapeFacebookPage(pageUrl)

  // Compare with stored posts and add new ones
  const cleanedPosts = result.posts.map((post) => ({
    ...post,
    text: cleanFacebookText(post.text) || post.text,
    link: normalizeFacebookLink(post.link),
    mediaType: inferMediaType(post)
  })).filter((post) => !isFacebookCommentLink(post.link))

  const newPosts = cleanedPosts.length ? await addNewPosts(cleanedPosts, 'facebook') : []

  // Get all stored posts for display
  const allPosts = await getStoredPosts('facebook')

  const seen = new Set<string>()
  const dailyPosts = allPosts.filter((post) => isInsideTodayWindow(post) && !isFacebookCommentLink(post.link))
  const items: DisplayItem[] = dailyPosts.filter((post) => {
    const key = getPublicationKey(post)
    if (!key) return false
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 80).map((post, index) => ({
    id: createDisplayId(post, index),
    context: cleanFacebookText(post.text) || post.text,
    fullText: cleanFacebookText(post.text) || post.text,
    image: post.image,
    link: normalizeFacebookLink(post.link),
    mediaType: inferMediaType(post),
    createdAt: post.date || post.detectedAt,
    isNew: newPosts.some((np) => np.id === post.id)
  }))

  const textKeys = new Set(items.map((item) => getTextKey(item.context)).filter(Boolean))
  const supplementalItems = await fetchDailyWebItems(textKeys).catch(() => [])
  const displayItems = [...items, ...supplementalItems]
    .sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))
    .slice(0, 80)

  return {
    items: displayItems,
    source: 'facebook',
    totalStored: allPosts.length,
    newDetected: newPosts.length,
    message: newPosts.length > 0
      ? `Se detectaron ${newPosts.length} publicación(es) nueva(s). Mostrando ${displayItems.length} publicaciones de hoy de 6:00 a. m. a medianoche.`
      : `Mostrando ${displayItems.length} publicación(es) de hoy entre 6:00 a. m. y medianoche.`
  }
})
