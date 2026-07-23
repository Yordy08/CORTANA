export interface InstagramPost {
  image?: string
  text: string
  date?: string
  link: string
  mediaType?: 'image' | 'video' | 'text'
}

type InstagramEdge = {
  node?: {
    shortcode?: string
    is_video?: boolean
    taken_at_timestamp?: number
    display_url?: string
    thumbnail_src?: string
    edge_media_to_caption?: {
      edges?: Array<{
        node?: {
          text?: string
        }
      }>
    }
  }
}

function getInstagramUsername(profileUrl: string) {
  try {
    const url = new URL(profileUrl)
    return url.pathname.split('/').filter(Boolean)[0] || ''
  } catch {
    return ''
  }
}

function getInstagramHeaders(username: string) {
  const headers: Record<string, string> = {
    accept: '*/*',
    'accept-language': 'es-CO,es;q=0.9,en;q=0.8',
    referer: `https://www.instagram.com/${username}/`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'x-asbd-id': '129477',
    'x-ig-app-id': '936619743392459',
    'x-requested-with': 'XMLHttpRequest'
  }

  const cookie = process.env.INSTAGRAM_COOKIE || process.env.INSTAGRAM_SESSION_COOKIE
  const sessionId = process.env.INSTAGRAM_SESSIONID || process.env.IG_SESSIONID
  if (cookie) headers.cookie = cookie
  if (!cookie && sessionId) headers.cookie = `sessionid=${sessionId}`

  return headers
}

function parseInstagramPayload(payload: any, username: string): InstagramPost[] {
  const edges = payload?.data?.user?.edge_owner_to_timeline_media?.edges as InstagramEdge[] | undefined

  return (edges || []).map(({ node }) => {
    const shortcode = node?.shortcode || ''
    const caption = node?.edge_media_to_caption?.edges?.[0]?.node?.text?.trim() || '(Publicación sin texto visible)'
    const timestamp = node?.taken_at_timestamp

    return {
      text: caption,
      image: node?.display_url || node?.thumbnail_src,
      date: timestamp ? new Date(timestamp * 1000).toISOString() : undefined,
      link: shortcode ? `https://www.instagram.com/p/${shortcode}/` : `https://www.instagram.com/${username}/`,
      mediaType: node?.is_video ? 'video' : node?.display_url || node?.thumbnail_src ? 'image' : 'text'
    } satisfies InstagramPost
  })
}

async function scrapeInstagramWebApi(profileUrl: string): Promise<{
  posts: InstagramPost[]
  error?: string
}> {
  const username = getInstagramUsername(profileUrl)
  if (!username) return { posts: [], error: 'No se pudo detectar el usuario de Instagram.' }

  try {
    const endpoints = [
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`
    ]
    const errors: string[] = []

    for (const endpoint of endpoints) {
      const response = await fetch(endpoint, {
        headers: getInstagramHeaders(username),
        signal: AbortSignal.timeout(20000)
      })

      if (!response.ok) {
        errors.push(`${new URL(endpoint).hostname}: ${response.status}`)
        continue
      }

      const payload = await response.json()
      const posts = parseInstagramPayload(payload, username)

      if (posts.length > 0) {
        return { posts }
      }

      errors.push(`${new URL(endpoint).hostname}: sin publicaciones`)
    }

    return {
      posts: [],
      error: `No se encontraron publicaciones en Instagram. ${errors.join(' | ')}`
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error desconocido al consultar Instagram'
    return { posts: [], error: message }
  }
}

export async function scrapeInstagramProfile(profileUrl: string): Promise<{
  posts: InstagramPost[]
  error?: string
}> {
  let browser
  const isServerless = Boolean(process.env.VERCEL)

  try {
    if (isServerless) {
      return await scrapeInstagramWebApi(profileUrl)
    }

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,900'
    ]

    const { chromium } = await import('playwright')

    browser = await chromium.launch({
      headless: true,
      args: launchArgs
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

    await page.waitForTimeout(isServerless ? 1000 : 5000)

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
        await detailPage.waitForTimeout(1200)

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
    const scrollRounds = isServerless ? 0 : 10
    for (let i = 0; i < scrollRounds; i++) {
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
    const detailCandidates = collectedPosts.slice(0, isServerless ? 0 : 24)
    for (let i = 0; i < detailCandidates.length; i += 4) {
      posts.push(...await Promise.all(detailCandidates.slice(i, i + 4).map(getPostDetails)))
    }

    if (isServerless) {
      posts.push(...collectedPosts.slice(0, 24))
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
