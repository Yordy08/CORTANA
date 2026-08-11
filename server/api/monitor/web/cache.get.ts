import { deletePostsBefore, getStoredPosts } from '../../../utils/storage'

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

  const colombia = new Date(now.getTime() - 5 * 60 * 60 * 1000)
  const start = new Date(Date.UTC(
    colombia.getUTCFullYear(),
    colombia.getUTCMonth(),
    colombia.getUTCDate(),
    5,
    0,
    0,
    0
  ))
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return timestamp >= start.getTime() && timestamp < end.getTime()
}

export default defineEventHandler(async () => {
  const now = new Date()
  const colombia = new Date(now.getTime() - 5 * 60 * 60 * 1000)
  const colombiaHour = colombia.getUTCHours()
  // Keep the previous calendar day until the 6:00 a. m. rollover.
  const cleanupStart = new Date(Date.UTC(
    colombia.getUTCFullYear(),
    colombia.getUTCMonth(),
    colombia.getUTCDate() - (colombiaHour < 6 ? 1 : 0),
    5,
    0,
    0,
    0
  ))
  await deletePostsBefore('web', cleanupStart)
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
