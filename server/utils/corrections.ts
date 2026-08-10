import { createHash } from 'node:crypto'
import { getDatabase } from './mongodb'
import { deleteStoredPost, getStoredPosts, updateStoredPost, type ScrapedPost } from './storage'

export interface PostCorrection {
  id: string
  postId: string
  source: 'facebook' | 'web'
  field: string
  currentValue: string
  suggestedValue: string
  status: 'pending' | 'done'
  createdAt: string
  resolvedAt?: string
}

async function correctionsCollection() {
  const collection = (await getDatabase()).collection<PostCorrection>('corrections')
  await collection.createIndex({ status: 1, createdAt: -1 })
  return collection
}

function getCurrentValue(post: ScrapedPost | undefined, field: string) {
  if (field === 'category') return post?.category
  if (field === 'title') return post?.leadText
  if (field === 'image') return post?.image
  if (field === 'text') return post?.text
  return undefined
}

export async function getPendingCorrections() {
  const collection = await correctionsCollection()
  const all = await collection.find({ status: 'pending' }).sort({ createdAt: -1 }).toArray()

  for (const correction of all) {
    const post = (await getStoredPosts(correction.source)).find((item) => item.id === correction.postId)
    const currentValue = getCurrentValue(post, correction.field)
    if (currentValue && currentValue.trim() === correction.suggestedValue.trim()) {
      await collection.updateOne(
        { id: correction.id, status: 'pending' },
        { $set: { status: 'done', resolvedAt: new Date().toISOString() } }
      )
      correction.status = 'done'
    }
  }

  return all.filter((correction) => correction.status === 'pending')
}

export async function createCorrection(correction: Omit<PostCorrection, 'id' | 'status' | 'createdAt' | 'resolvedAt'>) {
  const collection = await correctionsCollection()
  const existing = await collection.findOne({ postId: correction.postId, field: correction.field, status: 'pending' })
  if (existing) return existing

  const newCorrection: PostCorrection = {
    id: `corr-${createHash('sha1').update(`${correction.postId}-${correction.field}-${Date.now()}`).digest('hex').slice(0, 12)}`,
    ...correction,
    status: 'pending',
    createdAt: new Date().toISOString()
  }
  await collection.insertOne(newCorrection)
  return newCorrection
}

export async function resolveCorrection(correctionId: string): Promise<{ correction: PostCorrection; updatedPost?: ScrapedPost } | null> {
  const collection = await correctionsCollection()
  const correction = await collection.findOne({ id: correctionId, status: 'pending' })
  if (!correction) return null

  const resolvedAt = new Date().toISOString()
  await collection.updateOne({ id: correctionId, status: 'pending' }, { $set: { status: 'done', resolvedAt } })
  correction.status = 'done'
  correction.resolvedAt = resolvedAt

  if (correction.field === 'delete') {
    await deleteStoredPost(correction.source, correction.postId)
    return { correction, updatedPost: { id: correction.postId } as ScrapedPost }
  }

  const update = correction.field === 'category'
    ? { category: correction.suggestedValue }
    : correction.field === 'title'
      ? { title: correction.suggestedValue }
      : correction.field === 'image'
        ? { image: correction.suggestedValue }
        : correction.field === 'text'
          ? { text: correction.suggestedValue, fullText: correction.suggestedValue }
          : {}
  const updatedPost = Object.keys(update).length
    ? await updateStoredPost(correction.source, correction.postId, update)
    : null

  return { correction, ...(updatedPost ? { updatedPost } : {}) }
}
