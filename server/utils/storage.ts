import { createHash } from 'node:crypto'
import type { Collection } from 'mongodb'
import { getDatabase } from './mongodb'

export interface ScrapedPost {
  id: string
  title?: string
  image?: string
  text: string
  fullText?: string
  leadText?: string
  category?: string
  date?: string
  link: string
  mediaType?: 'image' | 'video' | 'text'
  source: 'facebook' | 'web'
  detectedAt: string
  notified: boolean
}

type Source = ScrapedPost['source']
const COLLECTION = 'posts'
let collectionPromise: Promise<Collection<ScrapedPost>> | null = null

function normalizeLink(link = ''): string {
  if (!link.trim()) return ''
  try {
    const url = new URL(link)
    url.hash = ''
    for (const key of Array.from(url.searchParams.keys())) {
      if (key.startsWith('__') || key.startsWith('utm_') || key === 'fbclid') url.searchParams.delete(key)
    }
    return url.toString().toLowerCase()
  } catch {
    return link.trim().toLowerCase()
  }
}

function generateId(link: string, source: string): string {
  const key = normalizeLink(link) || link.trim().toLowerCase()
  return `${source}-${createHash('sha1').update(key || `${Date.now()}-${Math.random()}`).digest('hex')}`
}

function candidateKey(candidate: { link?: string; text?: string }, source: Source) {
  const linkKey = normalizeLink(candidate.link)
  return linkKey || candidate.text?.replace(/\s+/g, ' ').trim().slice(0, source === 'facebook' ? 180 : 160).toLowerCase() || ''
}

async function postsCollection() {
  if (!collectionPromise) {
    collectionPromise = (async () => {
      const collection = (await getDatabase()).collection<ScrapedPost>(COLLECTION)
      await Promise.all([
        collection.createIndex({ source: 1, detectedAt: -1 }),
        collection.createIndex({ source: 1, link: 1 })
      ])
      return collection
    })().catch((error) => {
      collectionPromise = null
      throw error
    })
  }
  return collectionPromise
}

export async function getStoredPosts(source: Source): Promise<ScrapedPost[]> {
  return (await postsCollection()).find({ source }).sort({ detectedAt: -1 }).toArray()
}

export async function deletePostsBefore(source: Source, before: Date) {
  const result = await (await postsCollection()).deleteMany({
    source,
    $or: [
      { date: { $lt: before.toISOString() } },
      { date: { $exists: false }, detectedAt: { $lt: before.toISOString() } }
    ]
  })
  return result.deletedCount
}

export async function addNewPosts(candidates: Array<{
  title?: string
  image?: string
  text: string
  fullText?: string
  leadText?: string
  category?: string
  date?: string
  link: string
  mediaType?: 'image' | 'video' | 'text'
}>, source: Source): Promise<ScrapedPost[]> {
  const collection = await postsCollection()
  const posts = await getStoredPosts(source)
  const newPosts: ScrapedPost[] = []
  const pendingInserts: ScrapedPost[] = []
  const pendingUpdates: Array<{ id: string; updates: Partial<ScrapedPost> }> = []

  for (const candidate of candidates) {
    if (!candidate.text && !candidate.image && !candidate.link) continue
    const key = candidateKey(candidate, source)
    const existing = posts.find((post) => candidateKey(post, source) === key)

    if (existing) {
      const updates: Partial<ScrapedPost> = {}
      if (candidate.text && candidate.text.length > existing.text.length) updates.text = candidate.text
      if (candidate.title && candidate.title !== existing.title) updates.title = candidate.title
      if (candidate.fullText && candidate.fullText !== existing.fullText) updates.fullText = candidate.fullText
      if (candidate.leadText && candidate.leadText !== existing.leadText) updates.leadText = candidate.leadText
      if (candidate.category && candidate.category !== existing.category) updates.category = candidate.category
      if (candidate.image && candidate.image !== existing.image) updates.image = candidate.image
      if (candidate.date && candidate.date !== existing.date) updates.date = candidate.date
      if (Object.keys(updates).length) {
        Object.assign(existing, updates)
        pendingUpdates.push({ id: existing.id, updates })
      }
      continue
    }

    if (newPosts.some((post) => candidateKey(post, source) === key)) continue
    const post: ScrapedPost = {
      id: generateId(candidate.link || candidate.text, source),
      title: candidate.title,
      image: candidate.image,
      text: candidate.text || '(Sin texto disponible)',
      fullText: candidate.fullText,
      leadText: candidate.leadText,
      category: candidate.category,
      date: candidate.date,
      link: candidate.link || '',
      mediaType: candidate.mediaType || (candidate.image ? 'image' : 'text'),
      source,
      detectedAt: new Date().toISOString(),
      notified: false
    }
     pendingInserts.push(post)
     newPosts.push(post)
     posts.unshift(post)
  }

  if (pendingInserts.length) await collection.insertMany(pendingInserts)
  if (pendingUpdates.length) {
    await collection.bulkWrite(pendingUpdates.map(({ id, updates }) => ({
      updateOne: { filter: { id, source }, update: { $set: updates } }
    })))
  }

  return newPosts
}

export async function updateStoredPost(source: Source, postId: string, update: Partial<ScrapedPost>) {
  const collection = await postsCollection()
  const result = await collection.findOneAndUpdate(
    { id: postId, source },
    { $set: update },
    { returnDocument: 'after' }
  )
  return result
}

export async function deleteStoredPost(source: Source, postId: string) {
  await (await postsCollection()).deleteOne({ id: postId, source })
}
