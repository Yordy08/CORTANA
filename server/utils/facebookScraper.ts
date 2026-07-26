import { chromium as playwrightChromium } from 'playwright'
import serverlessChromium from '@sparticuz/chromium'
import * as cheerio from 'cheerio'

export interface FacebookPost {
  image?: string
  text: string
  date?: string
  link: string
  mediaType?: 'image' | 'video' | 'text'
}

type GraphPost = {
  message?: string
  created_time?: string
  permalink_url?: string
  full_picture?: string
  attachments?: {
    data?: Array<{
      media_type?: string
      type?: string
      url?: string
      media?: { image?: { src?: string } }
      subattachments?: { data?: Array<{ media_type?: string; type?: string }> }
    }>
  }
}

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.6422.147 Mobile Safari/537.36'
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

function cleanText(value = '') {
  return value
    .replace(/\s+/g, ' ')
    .replace(/Ver más|Ver mas|Ver menos/gi, '')
    .trim()
}

function resolveFacebookUrl(href = '') {
  if (!href) return ''
  if (href.startsWith('/')) return `https://www.facebook.com${href}`
  if (href.startsWith('http')) return href
  return ''
}

function getPageId(pageUrl: string): string {
  try {
    const url = new URL(pageUrl)
    return url.pathname.replace(/\/$/, '').split('/').pop() || ''
  } catch {
    return ''
  }
}

function graphAttachmentIsVideo(post: GraphPost) {
  const attachments = post.attachments?.data || []
  return attachments.some((attachment) => {
    const nested = attachment.subattachments?.data || []
    return [attachment.media_type, attachment.type, ...nested.flatMap((item) => [item.media_type, item.type])]
      .some((type) => String(type || '').toLowerCase().includes('video'))
  })
}

async function scrapeFacebookGraphPage(pageUrl: string): Promise<{
  posts: FacebookPost[]
  error?: string
}> {
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN || process.env.FACEBOOK_PAGE_ACCESS_TOKEN
  if (!accessToken) return { posts: [], error: 'No hay token de Facebook configurado.' }

  const pageId = process.env.FACEBOOK_PAGE_ID || getPageId(pageUrl)
  if (!pageId) return { posts: [], error: 'No se pudo extraer el ID de la página.' }

  try {
    const apiUrl = new URL(`https://graph.facebook.com/v23.0/${encodeURIComponent(pageId)}/posts`)
    apiUrl.searchParams.set('fields', 'message,created_time,permalink_url,full_picture,attachments{media_type,type,url,media,subattachments}')
    apiUrl.searchParams.set('limit', '100')
    apiUrl.searchParams.set('access_token', accessToken)

    const response = await fetch(apiUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000)
    })
    const payload = await response.json() as { data?: GraphPost[]; error?: { message?: string } }
    if (!response.ok) return { posts: [], error: payload.error?.message || `Graph API HTTP ${response.status}` }

    const posts = (payload.data || []).map((post) => ({
      text: cleanText(post.message || '(Publicación sin texto visible)'),
      image: post.full_picture || post.attachments?.data?.[0]?.media?.image?.src,
      date: post.created_time,
      link: post.permalink_url || pageUrl,
      mediaType: graphAttachmentIsVideo(post) ? 'video' as const : post.full_picture ? 'image' as const : 'text' as const
    }))

    return { posts }
  } catch (err) {
    return { posts: [], error: err instanceof Error ? err.message : 'Error en Graph API' }
  }
}

const SCRAPE_TIMEOUT = 3500
const DESKTOP_TIMEOUT = 4500

function isLoginPage($: cheerio.CheerioAPI): boolean {
  const text = $('body').text().toLowerCase()
  if (text.includes('inicia sesión') || text.includes('iniciar sesión') || text.includes('login') || text.includes('log in')) return true
  if ($('form[action*="login"], form[action*="Login"]').length > 0) return true
  return false
}

async function fetchAndParse(url: string, userAgent: string, timeout = SCRAPE_TIMEOUT): Promise<{
  $?: cheerio.CheerioAPI
  html?: string
  error?: string
  status?: number
}> {
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'es-CO,es;q=0.9,en;q=0.8',
        'user-agent': userAgent,
        'cache-control': 'no-cache'
      },
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow'
    })

    if (!response.ok) {
      return { error: `HTTP ${response.status}`, status: response.status }
    }

    const html = await response.text()
    const $ = cheerio.load(html)

    if (isLoginPage($)) {
      return { html }
    }

    return { $, html }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'error de conexion' }
  }
}

function parseMbasicPosts($: cheerio.CheerioAPI): FacebookPost[] {
  const posts: FacebookPost[] = []
  const seen = new Set<string>()

  $('div.story_body, div[role="article"], div[id^="u_"], div.story_body_container, div.messagebody, div.msg').each((_i, el) => {
    const $el = $(el)

    let link = ''
    const linkEl = $el.find('a[href*="story.php"], a[href*="fbid"], a[href*="/posts/"], a[href*="/reel/"]').first()
    const href = linkEl.attr('href')
    if (href) link = resolveFacebookUrl(href)

    if (!link) {
      const allLinks = $el.find('a[href*="story.php"], a[href*="fbid"], a[href*="/posts/"], a[href*="/reel/"], a[href*="permalink"], a[href*="photo"]')
      for (const a of allLinks) {
        const candidate = resolveFacebookUrl($(a).attr('href') || '')
        if (candidate) { link = candidate; break }
      }
    }

    if (!link || seen.has(link)) return

    let text = ''
    const msgBody = $el.find('.message_body')
    if (msgBody.length) {
      text = cleanText(msgBody.text())
    } else {
      text = cleanText($el.text())
    }

    const image = $el.find('img[src*="fbcdn"], img[src*="scontent"], img[src*="fbexternal"]').first().attr('src')
    const date = $el.find('abbr, time').first().attr('title')
      || cleanText($el.find('abbr, time').first().text())
      || undefined

    const hasVideo = $el.find('video, a[href*="/videos/"], a[href*="/reel/"], a[href*="/watch/"]').length > 0
    const mediaType = hasVideo ? 'video' : image ? 'image' : 'text'

    if (!text && !image) return
    if (text.length < 10 && !image) return

    seen.add(link)
    posts.push({ text: text || '(Publicación sin texto visible)', image, date, link, mediaType })
  })

  return posts
}

function parseMobilePosts($: cheerio.CheerioAPI): FacebookPost[] {
  const posts: FacebookPost[] = []
  const seen = new Set<string>()

  $('a[href*="/posts/"], a[href*="story.php"], a[href*="permalink"], a[href*="/photo"], a[href*="/videos/"], a[href*="/reel/"]').each((_index, linkEl) => {
    const link = resolveFacebookUrl($(linkEl).attr('href'))
    if (!link || link.includes('comment_id=') || seen.has(link)) return

    let container = $(linkEl).parent()
    for (let i = 0; i < 5 && container.length && cleanText(container.text()).length < 80; i++) {
      container = container.parent()
    }

    const text = cleanText(container.text())
    const image = container.find('img[src*="fbcdn"], img[src*="scontent"]').first().attr('src')
    const date = container.find('abbr, time').first().attr('title')
      || cleanText(container.find('abbr, time').first().text())
      || undefined
    const hasVideo = Boolean(link.includes('/videos/') || link.includes('/reel/') || link.includes('/watch/'))
    const mediaType = hasVideo ? 'video' : image ? 'image' : 'text'

    if (!text && !image) return

    seen.add(link)
    posts.push({ text: text || '(Publicación sin texto visible)', image, date, link, mediaType })
  })

  return posts
}

function parseDesktopPosts($: cheerio.CheerioAPI): FacebookPost[] {
  const posts: FacebookPost[] = []
  const seen = new Set<string>()

  $('a[href*="/posts/"], a[href*="story.php"], a[href*="permalink"], a[href*="/reel/"]').each((_index, linkEl) => {
    const link = resolveFacebookUrl($(linkEl).attr('href'))
    if (!link || link.includes('comment_id=') || seen.has(link)) return

    let container = $(linkEl).parent()
    for (let i = 0; i < 6 && container.length && cleanText(container.text()).length < 100; i++) {
      container = container.parent()
    }

    const text = cleanText(container.text())
    const image = container.find('img[src*="fbcdn"], img[src*="scontent"]').first().attr('src')
    const date = container.find('abbr, time').first().attr('title')
      || cleanText(container.find('abbr, time').first().text())
      || undefined
    const hasVideo = Boolean(link.includes('/videos/') || link.includes('/reel/') || link.includes('/watch/'))
    const mediaType = hasVideo ? 'video' : image ? 'image' : 'text'

    if (!text && !image) return

    seen.add(link)
    posts.push({ text: text || '(Publicación sin texto visible)', image, date, link, mediaType })
  })

  return posts
}

async function scrapePublicFacebookPage(pageUrl: string): Promise<{
  posts: FacebookPost[]
  error?: string
}> {
  const pageId = getPageId(pageUrl)
  if (!pageId) return { posts: [], error: 'no se pudo extraer el ID de la pagina' }

  const attempts: Array<{ url: string; ua: string; parser: ($: cheerio.CheerioAPI) => FacebookPost[]; timeout: number }> = [
    // mbasic variants (mobile UA)
    { url: `https://mbasic.facebook.com/${pageId}`, ua: MOBILE_UA, parser: parseMbasicPosts, timeout: SCRAPE_TIMEOUT },
    { url: `https://mbasic.facebook.com/${pageId}?_rdr`, ua: MOBILE_UA, parser: parseMbasicPosts, timeout: SCRAPE_TIMEOUT },
    { url: `https://mbasic.facebook.com/${pageId}?v=timeline`, ua: MOBILE_UA, parser: parseMbasicPosts, timeout: SCRAPE_TIMEOUT },
    // m.facebook variants (mobile UA)
    { url: `https://m.facebook.com/${pageId}`, ua: MOBILE_UA, parser: parseMobilePosts, timeout: SCRAPE_TIMEOUT },
    { url: `https://m.facebook.com/${pageId}?v=timeline`, ua: MOBILE_UA, parser: parseMobilePosts, timeout: SCRAPE_TIMEOUT },
    // desktop (desktop UA)
    { url: pageUrl, ua: DESKTOP_UA, parser: parseDesktopPosts, timeout: DESKTOP_TIMEOUT },
  ]

  const results = await Promise.allSettled(
    attempts.map((a) =>
      fetchAndParse(a.url, a.ua, a.timeout).then((res) => {
        if (res.$ && !res.error) {
          const posts = a.parser(res.$)
          if (posts.length > 0) return posts.slice(0, 80)
        }
        return null
      })
    )
  )

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && r.value.length > 0) {
      return { posts: r.value }
    }
  }

  const errors: string[] = []
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value === null) errors.push('sin posts')
    if (r.status === 'rejected') errors.push(r.reason?.message || 'rejected')
  }

  return { posts: [], error: errors.join(' | ') || 'no se pudo scrapear Facebook' }
}

export async function scrapeFacebookPage(pageUrl: string): Promise<{
  posts: FacebookPost[]
  error?: string
}> {
  const graphResult = await scrapeFacebookGraphPage(pageUrl)
  if (graphResult.posts.length > 0) return graphResult

  const publicResult = await scrapePublicFacebookPage(pageUrl)
  if (publicResult.posts.length > 0) return publicResult

  let browser
  let context
  let page
  let shouldCloseContext = false
  const isServerless = Boolean(process.env.VERCEL)
  const browserWsEndpoint = process.env.FACEBOOK_BROWSER_WS_ENDPOINT || process.env.BROWSERLESS_WS_ENDPOINT
  const enableLocalBrowser = process.env.FACEBOOK_ENABLE_LOCAL_BROWSER !== 'false'

  // Do not wait for a local browser unless it was explicitly enabled.
  if (!browserWsEndpoint && !isServerless && !enableLocalBrowser) {
    return {
      posts: [],
      error: graphResult.error === 'No hay token de Facebook configurado.'
        ? graphResult.error
        : `${graphResult.error || 'Graph API sin respuesta.'} | ${publicResult.error || 'Facebook no entregó publicaciones públicas.'}`
    }
  }

  try {
    const launchArgs = isServerless ? serverlessChromium.args : [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=480,900'
    ]

    browser = browserWsEndpoint
      ? await playwrightChromium.connectOverCDP(browserWsEndpoint)
      : await playwrightChromium.launch({
          headless: true,
          args: launchArgs,
          ...(isServerless ? { executablePath: await serverlessChromium.executablePath() } : {})
        })

    if (browserWsEndpoint) {
      context = browser.contexts()[0]
      if (!context) {
          context = await browser.newContext({
          userAgent: DESKTOP_UA,
          viewport: { width: 1280, height: 900 },
          locale: 'es-CO',
          timezoneId: 'America/Bogota'
        })
        shouldCloseContext = true
      }
    } else {
      context = await browser.newContext({
        userAgent: DESKTOP_UA,
        viewport: { width: 1280, height: 900 },
        locale: 'es-CO',
        timezoneId: 'America/Bogota',
        extraHTTPHeaders: { 'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8' }
      })
      shouldCloseContext = true
    }

    page = await context.newPage()
    await page.route('**/*.{woff,woff2,ttf,eot}', (route) => route.abort())

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 })

    const dialogButtons = [
      'Permitir todas las cookies', 'Permitir cookies', 'Aceptar todas',
      'Aceptar', 'Allow all cookies', 'Accept all',
      'Ahora no', 'Not now', 'Cerrar', 'Close'
    ]
    for (const text of dialogButtons) {
      await page.getByText(text, { exact: true }).first().click({ timeout: 900 }).catch(() => {})
    }

    await page.waitForTimeout(2000)

    const collectedPosts: FacebookPost[] = []
    const seenPosts = new Set<string>()

    async function expandVisiblePostText() {
      for (let i = 0; i < 6; i++) {
        const expanded = await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('[role="button"], span, div'))
            .filter((element) => {
              const text = (element.textContent || '').trim()
              return text === 'Ver más' || text === 'Ver mas' || text === 'See more'
            })
          const button = candidates[0] as HTMLElement | undefined
          if (!button) return false
          button.click()
          return true
        })
        if (!expanded) break
        await page.waitForTimeout(300)
      }
    }

    async function collectVisiblePosts() {
      await expandVisiblePostText()
      const posts = await page.evaluate(() => {
        const results: Array<{ image?: string; text: string; date?: string; link: string; mediaType?: 'image' | 'video' | 'text' }> = []
        const seen = new Set<string>()

        function resolveUrl(href: string) {
          if (!href) return ''
          if (href.startsWith('/')) return `https://www.facebook.com${href}`
          if (href.startsWith('http')) return href
          return ''
        }

        function isCommentLink(link: string) {
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

        function looksLikeComment(element: Element) {
          if (element.closest('[aria-label*="Comentario"], [aria-label*="Comment"]')) return true
          const links = Array.from(element.querySelectorAll('a[href]'))
            .map((a) => resolveUrl(a.getAttribute('href') || ''))
            .filter(Boolean)
          return links.length > 0 && links.every((l) => isCommentLink(l))
        }

        function bestImage(element: Element) {
          const imgs = Array.from(element.querySelectorAll('img[src*="scontent"], img[src*="fbcdn"]'))
            .map((img) => ({
              src: img.getAttribute('src') || '',
              w: Number(img.getAttribute('width') || 0),
              h: Number(img.getAttribute('height') || 0),
              alt: img.getAttribute('alt') || ''
            }))
            .filter((img) => img.src && !img.alt.toLowerCase().includes('foto del perfil'))
            .sort((a, b) => (b.w * b.h) - (a.w * a.h))
          return imgs[0]?.src || undefined
        }

        function extractText(element: Element) {
          const ignored = new Set(['Me gusta', 'Comentar', 'Compartir', 'Enviar', 'Ver más', 'Ver mas', 'Ver menos'])
          const lines = Array.from(element.querySelectorAll('[dir="auto"]'))
            .filter((el) => !el.querySelector('[dir="auto"]'))
            .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
            .map((t) => t.replace(/Ver menos$/i, '').replace(/Ver más$/i, '').replace(/Ver mas$/i, '').trim())
            .filter((t) => t.length > 10 && !ignored.has(t))
          const structuredText = Array.from(new Set(lines)).join('\n\n').trim()
          if (structuredText) return structuredText

          return (element as HTMLElement).innerText
            .replace(/\s+/g, ' ')
            .replace(/Ver más|Ver mas|Ver menos/gi, '')
            .trim()
        }

        function extractPost(element: Element) {
          if (looksLikeComment(element)) return

          const text = extractText(element)
          const image = bestImage(element)
          const hasVideo = Boolean(
            element.querySelector('video, a[href*="/videos/"], a[href*="/reel/"], a[href*="/watch/"], [aria-label*="Reproducir"], [aria-label*="Play"]')
          )
          const mediaType = hasVideo ? 'video' : image ? 'image' : 'text'
          const linkEls = element.querySelectorAll(
            'a[href*="/posts/"], a[href*="/photo/"], a[href*="/videos/"], a[href*="/reel/"], a[href*="/watch/"], a[href*="permalink"]'
          )
          let link = ''
          for (const a of linkEls) {
            const candidate = resolveUrl(a.getAttribute('href') || '')
            if (isCommentLink(candidate)) continue
            link = candidate
            if (link) break
          }
          if (!link) {
            const fallbackLink = element.querySelector('a[href*="/posts/"], a[href*="/reel/"], a[href*="/videos/"], a[href*="/watch/"], a[href*="permalink"]')
            link = resolveUrl(fallbackLink?.getAttribute('href') || '')
          }
          const timeEl = element.querySelector('time, a[href*="/posts/"] span, a[href*="/videos/"] span, a[href*="/watch/"] span')
          const date = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || undefined
          const key = link || text.slice(0, 140)

          if (!key || isCommentLink(link) || seen.has(key) || (!text && !image && !hasVideo)) return

          seen.add(key)
          results.push({ text: text || '(Publicación sin texto visible)', image, date, link, mediaType })
        }

        const postElements = document.querySelectorAll('div[role="article"]')
        for (const el of postElements) extractPost(el)

        if (results.length === 0) {
          const feeds = document.querySelectorAll('div[data-pagelet^="Feed"], div[data-pagelet^="Timeline"], [role="feed"]')
          for (const feed of feeds) {
            for (const block of feed.querySelectorAll(':scope > div > div > div')) {
              extractPost(block)
            }
          }
        }

        // Facebook frequently changes the internal dir/aria structure. Keep
        // a minimal article parser so visible posts are not discarded when
        // those selectors change.
        if (results.length === 0) {
          for (const article of document.querySelectorAll('[role="article"]')) {
            const text = ((article as HTMLElement).innerText || '')
              .replace(/\s+/g, ' ')
              .replace(/Ver más|Ver mas|Ver menos/gi, '')
              .trim()
            const anchor = article.querySelector('a[href*="/posts/"], a[href*="/reel/"], a[href*="/videos/"], a[href*="/stories/"], a[href*="/photo/"]')
            const link = resolveUrl(anchor?.getAttribute('href') || '')
            const image = bestImage(article)
            const hasVideo = Boolean(article.querySelector('video, a[href*="/reel/"], a[href*="/videos/"], a[href*="/watch/"]'))
            if (!text || !link || isCommentLink(link)) continue
            results.push({ text, image, link, mediaType: hasVideo ? 'video' : image ? 'image' : 'text' })
          }
        }

        return results
      })

      for (const post of posts) {
        const key = post.link || post.text.slice(0, 140)
        if (!key || seenPosts.has(key)) continue
        seenPosts.add(key)
        collectedPosts.push(post)
      }
    }

    async function collectSimpleVisibleArticles() {
      const articles = await page.locator('[role="article"]').evaluateAll((elements) => elements.map((element) => {
        const text = (element as HTMLElement).innerText
          .replace(/\s+/g, ' ')
          .replace(/Ver más|Ver mas|Ver menos/gi, '')
          .trim()
        const linkElement = element.querySelector('a[href*="/posts/"], a[href*="/reel/"], a[href*="/videos/"], a[href*="/stories/"], a[href*="/photo/"]')
        const href = linkElement?.getAttribute('href') || ''
        const image = element.querySelector('img[src*="scontent"], img[src*="fbcdn"]')?.getAttribute('src') || undefined
        const mediaType = element.querySelector('video, a[href*="/reel/"], a[href*="/videos/"], a[href*="/watch/"]')
          ? 'video' as const
          : image ? 'image' as const : 'text' as const
        return { text, href, image, mediaType }
      }))

      for (const article of articles) {
        if (!article.text || !article.href) continue
        const link = article.href.startsWith('/') ? `https://www.facebook.com${article.href}` : article.href
        if (seenPosts.has(link) || isCommentLink(link)) continue
        seenPosts.add(link)
        collectedPosts.push({
          text: article.text,
          image: article.image,
          link,
          mediaType: article.mediaType
        })
      }
    }

    await collectVisiblePosts()
    if (collectedPosts.length === 0) await collectSimpleVisibleArticles()

    let roundsWithoutNewPosts = 0
    for (let i = 0; i < 4; i++) {
      const beforeCount = collectedPosts.length
      await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 1.15)))
      await page.waitForTimeout(800)
      await collectVisiblePosts()

      if (collectedPosts.length === beforeCount) {
        roundsWithoutNewPosts += 1
      } else {
        roundsWithoutNewPosts = 0
      }
      if (collectedPosts.length >= 30 || roundsWithoutNewPosts >= 2) break
    }

    const posts = collectedPosts.slice(0, 60)

    return {
      posts: posts || [],
      error: posts.length === 0
        ? publicResult.error || 'No se encontraron publicaciones visibles en la pagina.'
        : undefined
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido al acceder a Facebook'
    return { posts: [], error: publicResult.error ? `${publicResult.error} | ${message}` : message }
  } finally {
    if (page) await page.close().catch(() => {})
    if (shouldCloseContext && context) await context.close().catch(() => {})
    if (!browserWsEndpoint && browser) await browser.close().catch(() => {})
  }
}
