import { chromium } from 'playwright'

export interface InstagramPost {
  image?: string
  text: string
  date?: string
  link: string
  mediaType?: 'image' | 'video' | 'text'
}

export async function scrapeInstagramProfile(profileUrl: string): Promise<{
  posts: InstagramPost[]
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
      extraHTTPHeaders: {
        'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8'
      }
    })

    const page = await context.newPage()
    await page.route('**/*.{woff,woff2,ttf,eot}', (route) => route.abort())

    await page.goto(profileUrl, {
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
      'Not now'
    ]

    for (const text of dialogButtons) {
      await page.getByText(text, { exact: true }).first().click({ timeout: 900 }).catch(() => {})
    }

    await page.waitForTimeout(5000)

    const collectedPosts: InstagramPost[] = []
    const seenPosts = new Set<string>()

    async function collectVisiblePosts() {
      const posts = await page.evaluate(String.raw`(() => {
        const results = []
        const seen = new Set()

        function cleanText(value) {
          return (value || '')
            .replace(/\s+/g, ' ')
            .replace(/^Foto del perfil de\s+[^.]+\.?/i, '')
            .replace(/^Imagen de\s+[^.]+\.?/i, '')
            .trim()
        }

        function resolveInstagramUrl(href) {
          if (!href) return ''
          if (href.startsWith('/')) return 'https://www.instagram.com' + href
          if (href.startsWith('http')) return href
          return ''
        }

        for (const anchor of document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
          const link = resolveInstagramUrl(anchor.getAttribute('href') || '')
          if (!link || seen.has(link)) continue

          const imageEl = anchor.querySelector('img') || anchor.closest('div')?.querySelector('img')
          const image = imageEl?.getAttribute('src') || undefined
          const text = cleanText(imageEl?.getAttribute('alt') || anchor.getAttribute('aria-label') || anchor.textContent || '')
          const mediaType = link.includes('/reel/') || anchor.querySelector('svg[aria-label*="Reel"], svg[aria-label*="Video"]') ? 'video' : image ? 'image' : 'text'

          if (!text && !image) continue

          seen.add(link)
          results.push({
            text: text || '(Publicación sin texto visible)',
            image,
            link,
            mediaType
          })
        }

        return results
      })()`)

      for (const post of posts) {
        const key = post.link || post.text.slice(0, 140)
        if (!key || seenPosts.has(key)) continue
        seenPosts.add(key)
        collectedPosts.push(post)
      }
    }

    async function getPostDetails(post: InstagramPost): Promise<InstagramPost> {
      if (!post.link) return post

      const detailPage = await context.newPage()
      await detailPage.route('**/*.{woff,woff2,ttf,eot}', (route) => route.abort())

      try {
        await detailPage.goto(post.link, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        })
        await detailPage.waitForTimeout(2500)

        const details = await detailPage.evaluate(String.raw`(() => {
          function cleanText(value) {
            return (value || '')
              .replace(/\s+\n/g, '\n')
              .replace(/\n\s+/g, '\n')
              .replace(/[ \t]+/g, ' ')
              .replace(/\n{3,}/g, '\n\n')
              .trim()
          }

          const captionEl = document.querySelector('article h1[dir="auto"], h1[dir="auto"]')
          const caption = cleanText(captionEl?.innerText || captionEl?.textContent || '')
          const image = document.querySelector('meta[property="og:image"]')?.getAttribute('content')
            || document.querySelector('article img[src*="cdninstagram"], img[src*="cdninstagram"]')?.getAttribute('src')
            || undefined
          const date = document.querySelector('time')?.getAttribute('datetime') || undefined
          const hasVideo = Boolean(document.querySelector('video, meta[property="og:video"], meta[property="og:video:url"]'))

          return { caption, image, date, hasVideo }
        })()`)

        return {
          ...post,
          text: details.caption || post.text,
          image: details.image || post.image,
          date: details.date || post.date,
          mediaType: details.hasVideo ? 'video' : post.mediaType
        }
      } catch {
        return post
      } finally {
        await detailPage.close().catch(() => {})
      }
    }

    await collectVisiblePosts()

    let roundsWithoutNewPosts = 0
    for (let i = 0; i < 10; i++) {
      const beforeCount = collectedPosts.length
      await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 1.2)))
      await page.waitForTimeout(1500)
      await collectVisiblePosts()

      if (collectedPosts.length === beforeCount) {
        roundsWithoutNewPosts += 1
      } else {
        roundsWithoutNewPosts = 0
      }

      if (collectedPosts.length >= 80 || roundsWithoutNewPosts >= 4) break
    }

    const posts: InstagramPost[] = []
    for (const post of collectedPosts.slice(0, 80)) {
      posts.push(await getPostDetails(post))
    }
    await context.close()

    return {
      posts,
      error: posts.length === 0 ? 'No se encontraron publicaciones visibles en Instagram.' : undefined
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido al acceder a Instagram'
    return { posts: [], error: message }
  } finally {
    if (browser) await browser.close().catch(() => {})
  }
}
