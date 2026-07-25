const PROXY_BASE = '/api/proxy/facebook'

// In-memory session cookie store (persists while server is running)
let sessionCookies: string[] = []

// Allowed Facebook domains for security
const ALLOWED_DOMAINS = [
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'mbasic.facebook.com',
  'fb.com',
  'm.me',
  'l.facebook.com',
  'lm.facebook.com',
  'graph.facebook.com',
  'api.facebook.com',
  'connect.facebook.net',
  'static.xx.fbcdn.net',
  'scontent.xx.fbcdn.net',
  'scontent.f',
  'fbcdn.net',
  'scontent',
]

function isAllowedDomain(url: string): boolean {
  try {
    const parsed = new URL(url)
    return ALLOWED_DOMAINS.some((domain) => parsed.hostname.includes(domain))
  } catch {
    return false
  }
}

function getProxyUrl(originalUrl: string): string {
  return `${PROXY_BASE}?url=${encodeURIComponent(originalUrl)}`
}

function resolveUrl(base: string, relative: string): string {
  try {
    return new URL(relative, base).toString()
  } catch {
    return relative
  }
}

function getCombinedCookies(incomingCookie: string): string {
  const allCookies = new Map<string, string>()

  // Add session cookies first (persistent from previous requests)
  for (const cookie of sessionCookies) {
    const [name, ...rest] = cookie.split('=')
    if (name && rest.length) allCookies.set(name.trim(), rest.join('=').split(';')[0].trim())
  }

  // Add incoming cookies from client (overwrites session if same key)
  if (incomingCookie) {
    for (const part of incomingCookie.split(';')) {
      const [name, ...rest] = part.split('=')
      if (name && rest.length) allCookies.set(name.trim(), rest.join('=').trim())
    }
  }

  return Array.from(allCookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
}

function rewriteHtml(baseUrl: string, html: string): string {
  // 1. Remove ALL frame-busting meta tags and headers
  let rewritten = html
    .replace(/<meta[^>]*http-equiv\s*=\s*["'](Content-Security-Policy|X-Frame-Options|Frame-Options)["'][^>]*>/gi, '')
    .replace(/<meta[^>]*content\s*=\s*["'][^"']*(DENY|SAMEORIGIN|frame-ancestors)[^"']*["'][^>]*>/gi, '')
    .replace(/x-frame-options/gi, 'x-frame-options-disabled')
    .replace(/frame-ancestors/gi, 'frame-ancestors-disabled')

  // 2. Neutralize ALL JavaScript frame-busting techniques
  const frameBustingPatterns = [
    /\b(top\s*\.\s*location)\b/g,
    /\b(parent\s*\.\s*location)\b/g,
    /\b(window\s*\.\s*top)\b/g,
    /\b(self\s*!==\s*(top|parent))\b/g,
    /\b(top\s*!==\s*(self|parent))\b/g,
    /\b(parent\s*!==\s*(self|top))\b/g,
    /\btry\s*\{[^}]*top\.location[^}]*\}[\s\S]*?catch/g,
    /\bif\s*\([^)]*(top\.|parent\.|window\.top)[^)]*\)/g,
  ]

  for (const pattern of frameBustingPatterns) {
    rewritten = rewritten.replace(pattern, '/* proxy-blocked */ /* $& */')
  }

  // 3. Rewrite all form actions to go through proxy
  rewritten = rewritten.replace(
    /<form([^>]*)\s+action\s*=\s*"([^"]*)"([^>]*)>/gi,
    (_match, before, action, after) => {
      const absoluteAction = resolveUrl(baseUrl, action)
      if (isAllowedDomain(absoluteAction)) {
        return `<form${before} action="${getProxyUrl(absoluteAction)}" method="POST"${after}>`
      }
      return _match
    }
  )
  rewritten = rewritten.replace(
    /<form([^>]*)\s+action\s*=\s*'([^']*)'([^>]*)>/gi,
    (_match, before, action, after) => {
      const absoluteAction = resolveUrl(baseUrl, action)
      if (isAllowedDomain(absoluteAction)) {
        return `<form${before} action="${getProxyUrl(absoluteAction)}" method="POST"${after}>`
      }
      return _match.replace(`action='${action}'`, `action="${getProxyUrl(absoluteAction)}" method="POST"`)
    }
  )

  // 4. Rewrite links (a tags)
  rewritten = rewritten.replace(
    /<a([^>]*)\s+href\s*=\s*"([^"]*)"([^>]*)>/gi,
    (_match, before, href, after) => {
      const absoluteHref = resolveUrl(baseUrl, href)
      if (isAllowedDomain(absoluteHref) && !href.startsWith('#') && !href.startsWith('javascript:')) {
        return `<a${before} href="${getProxyUrl(absoluteHref)}" target="_blank"${after}>`
      }
      if (href.startsWith('#') || href.startsWith('javascript:')) {
        return `<a${before} href="${href}"${after}>`
      }
      return _match
    }
  )

  // 5. Rewrite src attributes (images, scripts, iframes) to go through proxy
  rewritten = rewritten.replace(
    /(src|srcset|data-src)\s*=\s*"([^"]*)"/gi,
    (_match, attr, value) => {
      const absoluteValue = resolveUrl(baseUrl, value)
      if (isAllowedDomain(absoluteValue) && !absoluteValue.startsWith('data:')) {
        return `${attr}="${getProxyUrl(absoluteValue)}"`
      }
      return _match
    }
  )

  // 6. Add base tag
  if (!rewritten.includes('<base')) {
    rewritten = rewritten.replace('<head>', `<head>\n<base href="${getProxyUrl(baseUrl)}">`)
  }

  // 7. Inject frame-busting prevention script at the end of body
  const antiBustScript = `
<script>
// Prevent Facebook frame-busting
(function() {
  var originalLocation = window.location;
  Object.defineProperty(window, 'top', { value: window.self, writable: false });
  Object.defineProperty(window, 'parent', { value: window.self, writable: false });
  Object.defineProperty(window, 'frameElement', { value: null, writable: false });
  
  var locationDescriptor = Object.getOwnPropertyDescriptor(window, 'location');
  if (locationDescriptor && locationDescriptor.set) {
    var originalSet = locationDescriptor.set;
    Object.defineProperty(window, 'location', {
      set: function(value) {
        if (value && typeof value === 'string' && value.indexOf('${PROXY_BASE}') === -1) {
          return;
        }
        originalSet.call(window.location, value);
      },
      get: function() { return originalLocation; },
      configurable: false
    });
  }
  
  var originalPostMessage = window.postMessage;
  window.postMessage = function() {};
  
  console.log('[Cortana Proxy] Frame-busting prevention active');
})();
</script>
`
  if (rewritten.includes('</body>')) {
    rewritten = rewritten.replace('</body>', `${antiBustScript}\n</body>`)
  } else {
    rewritten += antiBustScript
  }

  return rewritten
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const method = event.method
  const targetUrl = String(query.url || 'https://m.facebook.com/login.php').trim()

  if (!targetUrl) {
    throw createError({ statusCode: 400, statusMessage: 'Falta la URL' })
  }

  if (!isAllowedDomain(targetUrl)) {
    throw createError({ statusCode: 400, statusMessage: 'Dominio no permitido. Solo se permiten dominios de Facebook.' })
  }

  // Get incoming cookies from client
  const incomingCookie = getHeader(event, 'cookie') || ''

  // Combine with stored session cookies
  const combinedCookies = getCombinedCookies(incomingCookie)

  const fetchHeaders: Record<string, string> = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language': 'es-CO,es;q=0.9,en;q=0.8',
    'referer': 'https://www.facebook.com/',
    'origin': 'https://www.facebook.com',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
    'upgrade-insecure-requests': '1',
  }

  if (combinedCookies) {
    fetchHeaders['cookie'] = combinedCookies
  }

  // Handle POST requests (form submissions for login)
  let body: string | undefined
  if (method === 'POST') {
    const rawBody = await readBody(event)
    if (rawBody) {
      body = typeof rawBody === 'string' ? rawBody : new URLSearchParams(rawBody).toString()
    }
    fetchHeaders['content-type'] = 'application/x-www-form-urlencoded'
    const referer = getHeader(event, 'referer')
    if (referer) {
      fetchHeaders['referer'] = referer
    }
  }

  try {
    const response = await fetch(targetUrl, {
      method: method || 'GET',
      headers: fetchHeaders,
      body: body || undefined,
      signal: AbortSignal.timeout(45000),
      redirect: 'manual'
    })

    // Collect ALL cookies from response (including Set-Cookie headers)
    const setCookieHeaders: string[] = []
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') {
        setCookieHeaders.push(value)
      }
    })

    if (setCookieHeaders.length > 0) {
      for (const setCookie of setCookieHeaders) {
        const cookieName = setCookie.split('=')[0]?.trim()
        if (cookieName) {
          sessionCookies = sessionCookies.filter((c) => !c.startsWith(`${cookieName}=`))
          const cookieValue = setCookie.split(';')[0]
          if (cookieValue) {
            sessionCookies.push(cookieValue)
          }
        }
      }

      // Forward cookies to client browser with SameSite=None for cross-frame
      for (const setCookie of setCookieHeaders) {
        const modifiedCookie = setCookie
          .replace(/;\s*SameSite\s*=\s*(Lax|Strict)/gi, '; SameSite=None')
        if (!modifiedCookie.toLowerCase().includes('samesite')) {
          appendHeader(event, 'set-cookie', `${modifiedCookie}; SameSite=None`)
        } else {
          appendHeader(event, 'set-cookie', modifiedCookie)
        }
      }
    }

    // Handle redirects
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (location) {
        const redirectUrl = resolveUrl(targetUrl, location)
        if (isAllowedDomain(redirectUrl)) {
          return sendRedirect(event, `${PROXY_BASE}?url=${encodeURIComponent(redirectUrl)}`)
        }
      }
    }

    const contentType = response.headers.get('content-type') || 'text/html; charset=utf-8'

    // Set response headers WITHOUT frame-blocking headers
    setHeader(event, 'content-type', contentType)
    setHeader(event, 'cache-control', 'no-store, no-cache, must-revalidate')

    // If it's HTML, rewrite it. Otherwise pass through as-is.
    if (contentType.includes('text/html')) {
      const html = await response.text()
      const rewrittenHtml = rewriteHtml(targetUrl, html)
      return rewrittenHtml
    }

    // For non-HTML responses (images, JSON, etc.), pass through
    return new Uint8Array(await response.arrayBuffer())
  } catch (err: any) {
    if (err.message?.includes('timeout') || err.name === 'TimeoutError') {
      throw createError({ statusCode: 504, statusMessage: 'Facebook no respondió a tiempo. Intenta de nuevo.' })
    }
    throw createError({ statusCode: 502, statusMessage: `Error al conectar con Facebook: ${err.message || 'Error desconocido'}` })
  }
})

