import { addNewPosts, getStoredPosts } from '../../utils/storage'
import * as cheerio from 'cheerio'

type WebItem = {
  id: string
  title?: string
  context: string
  fullText?: string
  leadText?: string
  category?: string
  image?: string
  link?: string
  createdAt?: string
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
    'wp:term'?: Array<Array<{
      id: number
      name?: string
      taxonomy?: string
    }>>
  }
}

function cleanText(value = '') {
  return cheerio.load(value).text()
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function getMeta($: cheerio.CheerioAPI, property: string): string {
  const selectors = [
    `meta[property="${property}"]`,
    `meta[name="${property}"]`,
    `meta[property="og:${property}"]`,
    `meta[name="og:${property}"]`
  ]
  for (const sel of selectors) {
    const content = $(sel).attr('content')
    if (content) return cleanText(content)
  }
  return ''
}

function resolveUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value, baseUrl).toString()
  } catch {
    return undefined
  }
}

function getWordPressImage(post: WordPressPost): string | undefined {
  const media = post._embedded?.['wp:featuredmedia']?.[0]
  return media?.media_details?.sizes?.large?.source_url
    || media?.media_details?.sizes?.medium_large?.source_url
    || media?.media_details?.sizes?.medium?.source_url
    || media?.source_url
}

function getWordPressCategory(post: WordPressPost): string | undefined {
  const terms = post._embedded?.['wp:term']?.flat() || []
  return terms.find((term) => term.taxonomy === 'category' && term.name)?.name
}

function getFirstParagraph(html = '') {
  const $ = cheerio.load(html)
  const paragraph = $('p')
    .map((_i, element) => cleanText($(element).text()))
    .get()
    .find((text) => text.length > 35)

  return paragraph || cleanText(html).slice(0, 320)
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

async function fetchWordPressCandidates(baseUrl: URL) {
  const apiUrl = new URL('/wp-json/wp/v2/posts', baseUrl)
  apiUrl.searchParams.set('per_page', '80')
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
  const todayPosts = posts.filter(isInsideTodayWindow)
  const selectedPosts = todayPosts.length ? todayPosts : posts

  return selectedPosts.slice(0, 80).map((post) => {
    const title = cleanText(post.title?.rendered)
    const excerpt = cleanText(post.excerpt?.rendered || post.content?.rendered).slice(0, 280)
    const fullText = cleanText(post.content?.rendered || post.excerpt?.rendered)
    const leadText = getFirstParagraph(post.content?.rendered || post.excerpt?.rendered)

    return {
      image: getWordPressImage(post),
      text: title ? `${title}: ${excerpt || 'Sin descripción disponible.'}` : excerpt,
      fullText: title ? `${title}: ${fullText || excerpt || 'Sin descripción disponible.'}` : fullText || excerpt,
      leadText,
      category: getWordPressCategory(post),
      date: post.date,
      link: post.link || baseUrl.toString()
    }
  }).filter((post) => post.text && post.link)
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const targetUrl = String(query.url || '').trim()

  if (!targetUrl) {
    throw createError({ statusCode: 400, statusMessage: 'Falta el parámetro url.' })
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(targetUrl)
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'El link de la web no es válido.' })
  }

  let candidates: Array<{ image?: string; text: string; fullText?: string; leadText?: string; category?: string; date?: string; link: string }> = await fetchWordPressCandidates(parsedUrl)

  if (candidates.length === 0) {
    const response = await fetch(parsedUrl.toString(), {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 CortanaMonitor/2.0',
        accept: 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(15000)
    })

    if (!response.ok) {
      throw createError({ statusCode: response.status, statusMessage: 'La web no respondió correctamente.' })
    }

    const html = await response.text()
    const $ = cheerio.load(html)

    candidates = []

  // Extract from article elements
    $('article').each((_i, articleEl) => {
      const $article = $(articleEl)
      const title = cleanText($article.find('h1, h2, h3').first().text())
      const text = cleanText($article.find('p').first().text()) || title
      const image = resolveUrl($article.find('img').first().attr('src'), parsedUrl.toString())
      const link = resolveUrl($article.find('a').first().attr('href'), parsedUrl.toString())

      if (text && text.length > 20) {
        candidates.push({
          text: title ? `${title}: ${text}` : text,
          fullText: title ? `${title}: ${text}` : text,
          leadText: text,
          image,
          link: link || parsedUrl.toString()
        })
      }
    })

    // If no articles found, use meta tags
    if (candidates.length === 0) {
      const title = getMeta($, 'og:title') || cleanText($('title').text())
      const description = getMeta($, 'og:description') || getMeta($, 'description') || ''
      const image = resolveUrl(getMeta($, 'og:image'), parsedUrl.toString())

      if (title || description) {
        candidates.push({
          text: title ? `${title} — ${description || 'Sin descripción'}` : description,
          fullText: title ? `${title} — ${description || 'Sin descripción'}` : description,
          leadText: description,
          image,
          link: parsedUrl.toString()
        })
      }
    }
  }

  // Deduplicate the candidates themselves
  const seen = new Set<string>()
  const uniqueCandidates = candidates.filter((c) => {
    const key = c.link || c.text.slice(0, 80)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const categoryByLink = new Map(uniqueCandidates.map((candidate) => [candidate.link, candidate.category]))

  // Store new posts
  const newPosts = await addNewPosts(uniqueCandidates, 'web')
  const allPosts = await getStoredPosts('web')
  const dailyPosts = allPosts.filter(isInsideTodayWindow)

  const items: WebItem[] = dailyPosts.slice(0, 80).map((post) => ({
    id: post.id,
    title: post.text.split(':')[0]?.trim() || post.text.slice(0, 60),
    context: post.text.includes(':') ? post.text.split(':').slice(1).join(':').trim().slice(0, 260) : post.text.slice(0, 260),
    fullText: post.fullText || post.text,
    leadText: post.leadText,
    category: post.category || categoryByLink.get(post.link),
    image: post.image,
    link: post.link,
    createdAt: post.date || post.detectedAt,
    isNew: newPosts.some((np) => np.id === post.id)
  }))

  return {
    items,
    source: 'web',
    totalStored: allPosts.length,
    newDetected: newPosts.length,
    message: newPosts.length > 0
      ? `Se detectaron ${newPosts.length} publicación(es) nueva(s) en la web. Mostrando ${items.length} publicación(es) de hoy entre 6:00 a. m. y medianoche.`
      : `Mostrando ${items.length} publicación(es) de hoy entre 6:00 a. m. y medianoche.`
  }
})
