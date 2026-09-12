import { getStoredPosts } from '../../../utils/storage'

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
  isNew: boolean
}

function isInsideTodayWindow(post: { date?: string; detectedAt?: string }, now = new Date()) {
  const timestamp = Date.parse(post.date || post.detectedAt || '')
  if (Number.isNaN(timestamp)) return false

  const dateKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now)
  const [year, month, day] = dateKey.split('-').map(Number)
  const start = new Date(Date.UTC(year, month - 1, day, 5, 0, 0, 0))
  const end = new Date(Date.UTC(year, month - 1, day + 1, 5, 0, 0, 0))
  return timestamp >= start.getTime() && timestamp < end.getTime()
}

export default defineEventHandler(async () => {
  const now = new Date()
  const posts = (await getStoredPosts('web'))
    .filter((post) => isInsideTodayWindow(post, now))
    .sort((a, b) => {
      const aTime = Date.parse(a.date || a.detectedAt) || 0
      const bTime = Date.parse(b.date || b.detectedAt) || 0
      return bTime - aTime
    })
  const items: WebItem[] = posts.map((post) => ({
    id: post.id,
    title: post.title || post.text.split(':')[0]?.trim() || post.text.slice(0, 60),
    context: post.text.includes(':') ? post.text.split(':').slice(1).join(':').trim().slice(0, 260) : post.text.slice(0, 260),
    fullText: post.fullText || post.text,
    leadText: post.leadText,
    category: post.category,
    image: post.image,
    link: post.link,
    createdAt: post.date || post.detectedAt,
    isNew: false
  }))

  return {
    items,
    source: 'web-cache',
    totalStored: posts.length,
    newDetected: 0,
    message: items.length ? `Mostrando ${items.length} publicación(es) guardada(s). Actualizando en segundo plano.` : ''
  }
})
