export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const targetUrl = String(query.url || '').trim()

  if (!targetUrl) {
    throw createError({ statusCode: 400, statusMessage: 'Falta la URL de la imagen.' })
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(targetUrl)
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'La URL de la imagen no es válida.' })
  }

  const allowedHosts = ['cdninstagram.com', 'fbcdn.net', 'scontent']
  if (!allowedHosts.some((host) => parsedUrl.hostname.includes(host))) {
    throw createError({ statusCode: 400, statusMessage: 'Dominio de imagen no permitido.' })
  }

  const response = await fetch(parsedUrl.toString(), {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 CortanaMonitor/2.0',
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      referer: 'https://www.instagram.com/'
    },
    signal: AbortSignal.timeout(15000)
  })

  if (!response.ok) {
    throw createError({ statusCode: response.status, statusMessage: 'No se pudo cargar la imagen.' })
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg'
  if (!contentType.startsWith('image/')) {
    throw createError({ statusCode: 415, statusMessage: 'El recurso no es una imagen.' })
  }

  setHeader(event, 'content-type', contentType)
  setHeader(event, 'cache-control', 'public, max-age=1800')
  return new Uint8Array(await response.arrayBuffer())
})
