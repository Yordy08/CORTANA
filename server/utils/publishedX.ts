import { getDatabase } from './mongodb'

type PublicationStatus = { postId: string; markedAt: string }
type CopyEvent = { postId: string; copiedAt: Date }

async function statusCollection() {
  const collection = (await getDatabase()).collection<PublicationStatus>('published_x')
  await collection.createIndex({ postId: 1 }, { unique: true })
  return collection
}

async function copiesCollection() {
  const collection = (await getDatabase()).collection<CopyEvent>('x_copy_events')
  await collection.createIndex({ copiedAt: -1 })
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
  return (await copiesCollection()).countDocuments({ copiedAt: { $gte: start, $lt: new Date(start.getTime() + 24 * 60 * 60 * 1000) } })
}

export async function markPublishedOnX(postId: string) {
  const now = new Date()
  const status = await (await statusCollection()).findOne({ postId })
  if (!status) await (await copiesCollection()).insertOne({ postId, copiedAt: now })
  await (await statusCollection()).updateOne(
    { postId },
    { $set: { postId, markedAt: now.toISOString() } },
    { upsert: true }
  )
  return { postId, dailyCount: await getDailyPublishedCount() }
}

export async function unmarkPublishedOnX(postId: string) {
  await (await statusCollection()).deleteOne({ postId })
  await (await copiesCollection()).deleteMany({ postId })
  return { postId, dailyCount: await getDailyPublishedCount() }
}
