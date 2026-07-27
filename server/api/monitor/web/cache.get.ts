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

function isRecent(post: { date?: string; detectedAt?: string }) {
  const timestamp = Date.parse(post.date || post.detectedAt || '')
  return !Number.isNaN(timestamp) && Date.now() - timestamp <= 24 * 60 * 60 * 1000
}

export default defineEventHandler(async () => {
  const posts = (await getStoredPosts('web')).filter(isRecent)
  const items: WebItem[] = posts.slice(0, 80).map((post) => ({
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
