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
    11,
    0,
    0,
    0
  ))
  const end = new Date(Date.UTC(
    colombia.getUTCFullYear(),
    colombia.getUTCMonth(),
    colombia.getUTCDate() + 1,
    4,
    0,
    0,
    0
  ))
  return timestamp >= start.getTime() && timestamp < end.getTime()
}

export default defineEventHandler(async () => {
  const now = new Date()
  const colombia = new Date(now.getTime() - 5 * 60 * 60 * 1000)
  const colombiaHour = colombia.getUTCHours()
  // Clear the previous web day at the start of the new 06:00-23:00 window.
  const cleanupStart = new Date(Date.UTC(
    colombia.getUTCFullYear(),
    colombia.getUTCMonth(),
    colombia.getUTCDate() - (colombiaHour < 6 ? 1 : 0),
    11,
    0,
    0,
    0
  ))
  await deletePostsBefore('web', cleanupStart)
  if (colombiaHour < 6 || colombiaHour >= 23) {
    return {
      items: [],
      source: 'web-cache',
      totalStored: 0,
      newDetected: 0,
      message: 'La jornada web está cerrada. Comienza nuevamente a las 6:00 a. m.'
    }
  }
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
