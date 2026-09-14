import { addNewPosts, getStoredPosts } from '../../utils/storage'
import { getWordPressPageCache, setWordPressPageCache } from '../../utils/wpCache'
import * as cheerio from 'cheerio'
import { createHash } from 'node:crypto'

type WebItem = {
  id: string
  title?: string
  context: string
  fullText?: string
  leadText?: string
  author?: string
  category?: string
  image?: string
  link?: string
  createdAt?: string
}

type WordPressPost = {
  id: number
  date?: string
  date_gmt?: string
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
    author?: Array<{ name?: string }>
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
  const featuredImage = media?.media_details?.sizes?.medium_large?.source_url
    || media?.media_details?.sizes?.large?.source_url
    || media?.media_details?.sizes?.medium?.source_url
    || media?.source_url
  if (featuredImage) return featuredImage

  const $ = cheerio.load(post.content?.rendered || '')
  const image = $('img').first()
  const srcset = image.attr('srcset') || image.attr('data-srcset')
  return srcset?.split(',')[0]?.trim().split(/\s+/)[0]
    || image.attr('src')
    || image.attr('data-src')
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

function getColombiaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date)
}

function getTodayWindowInColombia(now = new Date()) {
  const dateKey = getColombiaDateKey(now)
  const [year, month, day] = dateKey.split('-').map(Number)
  return {
    dateKey,
    start: new Date(Date.UTC(year, month - 1, day, 5, 0, 0, 0)),
    end: new Date(Date.UTC(year, month - 1, day + 1, 5, 0, 0, 0))
  }
}

function isInsideTodayWindow(post: { detectedAt?: string; date?: string; date_gmt?: string }) {
  const timestamp = Date.parse(post.date_gmt ? `${post.date_gmt}Z` : post.date || post.detectedAt || '')
  if (Number.isNaN(timestamp)) return false

  const { start, end } = getTodayWindowInColombia()
  return timestamp >= start.getTime() && timestamp < end.getTime()
}

function getWordPressDate(post: WordPressPost) {
  return post.date_gmt ? `${post.date_gmt}Z` : post.date
}

async function fetchWordPressCandidates(baseUrl: URL) {
  try {
    const apiUrl = new URL('/wp-json/wp/v2/posts', baseUrl)
    const { dateKey } = getTodayWindowInColombia()
    // Only request fields used by the monitor. The full embedded response is
    // unnecessarily large and makes every refresh wait several seconds.
    apiUrl.searchParams.set('per_page', '100')
    // `_links` is required by WordPress for the requested embedded media to be
    // included alongside `_embedded`.
    apiUrl.searchParams.set('_fields', 'id,date,date_gmt,link,title,excerpt,content,_embedded,_links')
    apiUrl.searchParams.set('_embed', '1')
    const posts: WordPressPost[] = []
    for (let page = 1; page <= 20; page++) {
      console.log(`[REVIEW] Consultando página ${page}`)
      apiUrl.searchParams.set('page', String(page))
      const cacheKey = apiUrl.toString()
      const cachedPage = getWordPressPageCache<WordPressPost[]>(cacheKey)

      if (cachedPage && cachedPage.expiresAt > Date.now()) {
        posts.push(...cachedPage.body)
        const reachedPreviousDay = cachedPage.body.some((post) => {
          const publishedAt = getWordPressDate(post)
          return publishedAt && getColombiaDateKey(new Date(publishedAt)) < dateKey
        })
        if (!cachedPage.body.length || reachedPreviousDay || cachedPage.body.length < 100) break
        continue
      }

      const conditionalHeaders: Record<string, string> = {
        'user-agent': 'Mozilla/5.0 CortanaMonitor/2.0',
        accept: 'application/json'
      }
      if (cachedPage?.etag) conditionalHeaders['if-none-match'] = cachedPage.etag
      if (cachedPage?.lastModified) conditionalHeaders['if-modified-since'] = cachedPage.lastModified
      const response = await fetch(apiUrl, {
        headers: conditionalHeaders,
        signal: AbortSignal.timeout(8000)
      })

      if (response.status === 304 && cachedPage) {
        setWordPressPageCache(cacheKey, cachedPage)
        posts.push(...cachedPage.body)
        const reachedPreviousDay = cachedPage.body.some((post) => {
          const publishedAt = getWordPressDate(post)
          return publishedAt && getColombiaDateKey(new Date(publishedAt)) < dateKey
        })
        if (!cachedPage.body.length || reachedPreviousDay || cachedPage.body.length < 100) break
        continue
      }
      if (!response.ok) return []
      const pagePosts = await response.json() as WordPressPost[]
      setWordPressPageCache(cacheKey, {
        body: pagePosts,
        etag: response.headers.get('etag') || undefined,
        lastModified: response.headers.get('last-modified') || undefined,
        totalPages: response.headers.get('x-wp-totalpages') || undefined
      })
      posts.push(...pagePosts)
      const totalPages = Number(response.headers.get('x-wp-totalpages') || 0)
      const reachedPreviousDay = pagePosts.some((post) => {
        const publishedAt = getWordPressDate(post)
        return publishedAt && getColombiaDateKey(new Date(publishedAt)) < dateKey
      })
      if (!pagePosts.length || reachedPreviousDay || pagePosts.length < 100 || (totalPages > 0 && page >= Math.min(totalPages, 20))) break
    }

    return posts.filter(isInsideTodayWindow).map((post) => {
      const title = cleanText(post.title?.rendered)
      const excerpt = cleanText(post.excerpt?.rendered || post.content?.rendered).slice(0, 280)
      const fullText = cleanText(post.content?.rendered || post.excerpt?.rendered)
      const leadText = getFirstParagraph(post.content?.rendered || post.excerpt?.rendered)

      return {
        title,
        image: getWordPressImage(post),
        text: title ? `${title}: ${excerpt || 'Sin descripción disponible.'}` : excerpt,
        fullText: title ? `${title}: ${fullText || excerpt || 'Sin descripción disponible.'}` : fullText || excerpt,
        leadText,
        author: post._embedded?.author?.[0]?.name,
        category: getWordPressCategory(post),
        date: getWordPressDate(post),
        link: post.link || baseUrl.toString()
      }
    }).filter((post) => post.text && post.link)
  } catch (error) {
    // The HTML scraper below is the fallback when REST is unavailable.
    console.error('[REVIEW ERROR] REST de WordPress no disponible', error)
    return []
  }
}

export default defineEventHandler(async (event) => {
  console.log('[REVIEW] Iniciando revisión')
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

  const { dateKey } = getTodayWindowInColombia()
  console.log(`[REVIEW] Fecha Colombia: ${dateKey}`)
  let candidates: Array<{ title?: string; image?: string; text: string; fullText?: string; leadText?: string; author?: string; category?: string; date?: string; link: string }> = await fetchWordPressCandidates(parsedUrl)

  if (candidates.length === 0) {
    const response = await fetch(parsedUrl.toString(), {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 CortanaMonitor/2.0',
        accept: 'text/html,application/xhtml+xml'
      },
      signal: AbortSignal.timeout(8000)
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
          title,
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
          title,
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
  console.log(`[REVIEW] Publicaciones encontradas: ${uniqueCandidates.length}`)
  const categoryByLink = new Map(uniqueCandidates.map((candidate) => [candidate.link, candidate.category]))

  // MongoDB is persistent, but it must not prevent a live response when it is
  // slow or temporarily unavailable on Render.
  let newPosts: Awaited<ReturnType<typeof addNewPosts>> = []
  let allPosts: Awaited<ReturnType<typeof getStoredPosts>> = []
  let storageAvailable = true
  try {
    newPosts = await addNewPosts(uniqueCandidates, 'web')
    allPosts = await getStoredPosts('web')
  } catch (error) {
    storageAvailable = false
    console.error('[REVIEW ERROR] No fue posible guardar o leer MongoDB', error)
  }

  const existingCount = Math.max(uniqueCandidates.length - newPosts.length, 0)
  console.log(`[REVIEW] Nuevas: ${newPosts.length}`)
  console.log(`[REVIEW] Existentes: ${existingCount}`)
  console.log('[REVIEW] Revisión finalizada')

  const currentKeys = new Set(uniqueCandidates.map((candidate) => candidate.link || candidate.text.slice(0, 80)))
  const recentPosts = allPosts
    .filter((post) => isInsideTodayWindow(post) && currentKeys.has(post.link || post.text.slice(0, 80)))
    .sort((a, b) => {
      const aTime = Date.parse(a.date || a.detectedAt) || 0
      const bTime = Date.parse(b.date || b.detectedAt) || 0
      return bTime - aTime
    })

  const items: WebItem[] = storageAvailable
    ? recentPosts.map((post) => ({
      id: post.id,
      title: post.title || post.text.split(':')[0]?.trim() || post.text.slice(0, 60),
      context: post.text.includes(':') ? post.text.split(':').slice(1).join(':').trim().slice(0, 260) : post.text.slice(0, 260),
       fullText: post.fullText || post.text,
       leadText: post.leadText,
       author: post.author,
      category: post.category || categoryByLink.get(post.link),
      image: post.image,
      link: post.link,
      createdAt: post.date || post.detectedAt,
      isNew: newPosts.some((np) => np.id === post.id)
    }))
    : uniqueCandidates.map((post, index) => ({
      id: `web-live-${createHash('sha1').update(post.link || post.text || String(index)).digest('hex')}`,
      title: post.title || post.text.split(':')[0]?.trim() || post.text.slice(0, 60),
      context: post.text.includes(':') ? post.text.split(':').slice(1).join(':').trim().slice(0, 260) : post.text.slice(0, 260),
       fullText: post.fullText || post.text,
       leadText: post.leadText,
       author: post.author,
      category: post.category,
      image: post.image,
      link: post.link,
      createdAt: post.date,
      isNew: true
    }))

  return {
    items,
    source: 'web',
    totalStored: items.length,
    newDetected: newPosts.length,
    found: uniqueCandidates.length,
    existing: existingCount,
    date: dateKey,
    message: newPosts.length > 0
      ? `Se detectaron ${newPosts.length} publicación(es) nueva(s). Mostrando ${items.length} publicación(es) de hoy.`
       : `Mostrando ${items.length} publicación(es) de hoy.`
  }
})
