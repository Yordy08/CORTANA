import { getDatabase } from './mongodb'

type PublicationStatus = { postId: string; markedAt: string }

async function statusCollection() {
  const collection = (await getDatabase()).collection<PublicationStatus>('published_x')
  await collection.createIndex({ postId: 1 }, { unique: true })
  await collection.createIndex({ markedAt: 1 })
  return collection
}

function colombiaDayStart(now = new Date()) {
  const colombia = new Date(now.getTime() - 5 * 60 * 60 * 1000)
  return new Date(Date.UTC(colombia.getUTCFullYear(), colombia.getUTCMonth(), colombia.getUTCDate(), 5, 0, 0, 0))
}

export async function getPublishedXIds() {
  return (await statusCollection()).find({}, { projection: { _id: 0, postId: 1 } }).toArray()
    .then((items) => items.map((item) => item.postId))
}

export async function getDailyPublishedCount() {
  const start = colombiaDayStart()
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  // markedAt is the source of truth shown by the UI. Counting copy events
  // can omit publications when the event write failed or predates migration.
  return (await statusCollection()).countDocuments({
    markedAt: { $gte: start.toISOString(), $lt: end.toISOString() }
  })
}

export async function markPublishedOnX(postId: string) {
  const now = new Date()
  await (await statusCollection()).updateOne(
    { postId },
    { $set: { postId, markedAt: now.toISOString() } },
    { upsert: true }
  )
  return { postId, dailyCount: await getDailyPublishedCount() }
}

export async function unmarkPublishedOnX(postId: string) {
  await (await statusCollection()).deleteOne({ postId })
  return { postId, dailyCount: await getDailyPublishedCount() }
}
