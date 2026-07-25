export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const targetUrl = String(query.url || 'https://m.facebook.com/login.php').trim()

  if (!targetUrl) {
    throw createError({ statusCode: 400, statusMessage: 'Falta la URL' })
  }

  // Only allow facebook domains
  try {
    const parsed = new URL(targetUrl)
    if (!parsed.hostname.includes('facebook.com') && !parsed.hostname.includes('fb.com')) {
      throw createError({ statusCode: 400, statusMessage: 'Dominio no permitido' })
    }
  } catch {
    // If invalid URL, use default
  }

  // Forward cookies from the client (if any were sent)
  const cookieHeader = getHeader(event, 'cookie') || ''

  const response = await fetch(targetUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'accept-language': 'es-CO,es;q=0.9,en;q=0.8',
      'cookie': cookieHeader,
      'referer': 'https://www.facebook.com/',
      'origin': 'https://www.facebook.com',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'upgrade-insecure-requests': '1'
    },
    signal: AbortSignal.timeout(30000),
    redirect: 'manual'
  })

  // Handle redirects manually (follow them)
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (location) {
      const redirectUrl = new URL(location, targetUrl).toString()
      // Only follow facebook redirects
      try {
        const parsedRedirect = new URL(redirectUrl)
        if (parsedRedirect.hostname.includes('facebook.com') || parsedRedirect.hostname.includes('fb.com')) {
          return fetch(redirectUrl, {
            headers: {
              'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
              'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
              'accept-language': 'es-CO,es;q=0.9,en;q=0.8',
              'cookie': cookieHeader,
              'referer': 'https://www.facebook.com/'
            },
            signal: AbortSignal.timeout(30000)
          })
        }
      } catch {
        // ignore invalid redirect URLs
      }
    }
  }

  const contentType = response.headers.get('content-type') || 'text/html; charset=utf-8'

  // Set response headers WITHOUT x-frame-options and without CSP that blocks iframes
  setHeader(event, 'content-type', contentType)
  setHeader(event, 'cache-control', 'no-store, no-cache, must-revalidate')

  // Forward cookies from Facebook to the client (for session persistence)
  const setCookieHeaders = response.headers.getSetCookie?.() || []
  if (setCookieHeaders.length > 0) {
    for (const setCookie of setCookieHeaders) {
      appendHeader(event, 'set-cookie', setCookie)
    }
  }

  const html = await response.text()

  // Modify the HTML to work better in an iframe:
  // 1. Remove any meta CSP tags that block framing
  // 2. Add base tag to ensure relative URLs resolve correctly
  // 3. Fix any relative URLs to absolute
  const modifiedHtml = html
    // Remove meta CSP headers
    .replace(/<meta[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi, '')
    // Remove X-Frame-Options meta tags
    .replace(/<meta[^>]*http-equiv\s*=\s*["']X-Frame-Options["'][^>]*>/gi, '')
    // Add base tag if not present
    .replace('<head>', `<head>\n<base href="${targetUrl}">`)
    // Replace _top targets with _blank to avoid breaking out of iframe
    .replace(/target\s*=\s*["']_top["']/gi, 'target="_blank"')
    // Prevent facebook from breaking out of iframe with JS
    .replace(/top\.location/g, 'self.location')
    .replace(/window\.top/g, 'window.self')
    .replace(/parent\.location/g, 'self.location')

  return modifiedHtml
})

