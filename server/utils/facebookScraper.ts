import { chromium } from 'playwright'

export interface FacebookPost {
  image?: string
  text: string
  date?: string
  link: string
  mediaType?: 'image' | 'video' | 'text'
}

/**
 * Scrape a public Facebook page using Playwright headless browser.
 * Visits the page, waits for posts to load, and extracts visible post data.
 */
export async function scrapeFacebookPage(pageUrl: string): Promise<{
  posts: FacebookPost[]
  error?: string
}> {
  let browser

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,900'
      ]
    })

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'es-CO',
      timezoneId: 'America/Bogota',
      // Block unnecessary resources for speed
      extraHTTPHeaders: {
        'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8'
      }
    })

    const page = await context.newPage()

    // Keep images enabled because they are part of the monitored content.
    await page.route('**/*.{woff,woff2,ttf,eot}', (route) => route.abort())

    // Navigate to the Facebook page
    await page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    })

    const dialogButtons = [
      'Permitir todas las cookies',
      'Permitir cookies',
      'Aceptar todas',
      'Aceptar',
      'Allow all cookies',
      'Accept all',
      'Ahora no',
      'Not now',
      'Cerrar',
      'Close'
    ]

    for (const text of dialogButtons) {
      await page.getByText(text, { exact: true }).first().click({ timeout: 900 }).catch(() => {})
    }

    // Wait a bit for JavaScript to render posts
    await page.waitForTimeout(5000)

    const collectedPosts: FacebookPost[] = []
    const seenPosts = new Set<string>()

    async function expandVisiblePostText() {
      for (let i = 0; i < 8; i++) {
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
        await page.waitForTimeout(350)
      }
    }

    async function collectVisiblePosts() {
      await expandVisiblePostText()
      const posts = await page.evaluate(() => {
      const results: Array<{ image?: string; text: string; date?: string; link: string; mediaType?: 'image' | 'video' | 'text' }> = []
      const seen = new Set<string>()

      function resolveFacebookUrl(href: string) {
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

      function looksLikeCommentContainer(element: Element) {
        if (element.closest('[aria-label*="Comentario"], [aria-label*="Comment"]')) return true
        const allLinks = Array.from(element.querySelectorAll('a[href]'))
          .map((a) => resolveFacebookUrl(a.getAttribute('href') || ''))
          .filter(Boolean)
        return allLinks.length > 0 && allLinks.every((link) => isCommentLink(link))
      }

      function pickBestImage(element: Element) {
        const images = Array.from(element.querySelectorAll('img[src*="scontent"], img[src*="fbcdn"]'))
          .map((img) => ({
            src: img.getAttribute('src') || '',
            width: Number(img.getAttribute('width') || 0),
            height: Number(img.getAttribute('height') || 0),
            alt: img.getAttribute('alt') || ''
          }))
          .filter((img) => img.src && !img.alt.toLowerCase().includes('foto del perfil'))
          .sort((a, b) => (b.width * b.height) - (a.width * a.height))

        return images[0]?.src || undefined
      }

      function extractText(element: Element) {
        const ignored = new Set(['Me gusta', 'Comentar', 'Compartir', 'Enviar', 'Ver más', 'Ver mas', 'Ver menos'])
        const lines = Array.from(element.querySelectorAll('[dir="auto"]'))
          .filter((el) => !el.querySelector('[dir="auto"]'))
          .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
          .map((text) => text.replace(/Ver menos$/i, '').replace(/Ver más$/i, '').replace(/Ver mas$/i, '').trim())
          .filter((text) => text.length > 10 && !ignored.has(text))
        const uniqueLines = Array.from(new Set(lines))

        return uniqueLines.join('\n\n').trim()
      }

      function extractPost(element: Element) {
        if (looksLikeCommentContainer(element)) return

        const text = extractText(element)
        const image = pickBestImage(element)
        const hasVideo = Boolean(
          element.querySelector('video, a[href*="/videos/"], a[href*="/watch/"], [aria-label*="Reproducir"], [aria-label*="Play"]')
        )
        const mediaType = hasVideo ? 'video' : image ? 'image' : 'text'
        const links = element.querySelectorAll(
          'a[href*="/posts/"], a[href*="/photo/"], a[href*="/videos/"], a[href*="/watch/"], a[href*="permalink"]'
        )
        let link = ''
        for (const a of links) {
          const candidateLink = resolveFacebookUrl(a.getAttribute('href') || '')
          if (isCommentLink(candidateLink)) continue
          link = candidateLink
          if (link) break
        }
        const timeEl = element.querySelector('time, a[href*="/posts/"] span, a[href*="/videos/"] span, a[href*="/watch/"] span')
        const date = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || undefined
        const key = link || text.slice(0, 140)

        if (!key || isCommentLink(link) || seen.has(key) || (!text && !image && !hasVideo)) return

        seen.add(key)
        results.push({ text: text || '(Publicación sin texto visible)', image, date, link, mediaType })
      }

      // --- Strategy 1: Look for article-like post containers ---
      // Facebook uses div[role="article"] for post containers
      const postElements = document.querySelectorAll('div[role="article"]')

      for (const element of postElements) {
        extractPost(element)
      }

      // --- Strategy 2: Fallback — look for the main feed areas ---
      if (results.length === 0) {
        const feedContainers = document.querySelectorAll(
          'div[data-pagelet^="Feed"], div[data-pagelet^="Timeline"], [role="feed"]'
        )

        for (const container of feedContainers) {
          const blocks = container.querySelectorAll(':scope > div > div > div')
          for (const block of blocks) {
            extractPost(block)
          }
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

    await collectVisiblePosts()

    let roundsWithoutNewPosts = 0

    // Collect after each scroll; Facebook can remove previous posts from DOM while new ones load.
    for (let i = 0; i < 25; i++) {
      const beforeCount = collectedPosts.length
      await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 1.15)))
      await page.waitForTimeout(2200)
      await collectVisiblePosts()

      if (collectedPosts.length === beforeCount) {
        roundsWithoutNewPosts += 1
      } else {
        roundsWithoutNewPosts = 0
      }

      if (collectedPosts.length >= 80 || roundsWithoutNewPosts >= 5) break
    }

    const posts = collectedPosts.slice(0, 80)

    await context.close()

    return {
      posts: posts || [],
      error: posts.length === 0 ? 'No se encontraron publicaciones visibles en la página.' : undefined
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido al acceder a Facebook'
    return { posts: [], error: message }
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}

