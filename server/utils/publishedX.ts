import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Redis } from '@upstash/redis'

const DATA_DIR = process.env.VERCEL ? join(tmpdir(), 'cortana-data') : join(process.cwd(), 'data')
const PUBLISHED_FILE = join(DATA_DIR, 'published-x.json')
const PUBLISHED_KEY = 'cortana:published-x'

const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const sharedStore = redisUrl && redisToken
  ? new Redis({ url: redisUrl, token: redisToken })
  : null

async function readPublishedIds(): Promise<string[]> {
  if (sharedStore) {
    try {
      return (await sharedStore.get<string[]>(PUBLISHED_KEY)) || []
    } catch {
      return []
    }
  }

  try {
    if (!existsSync(PUBLISHED_FILE)) return []
    return JSON.parse(await readFile(PUBLISHED_FILE, 'utf-8')) as string[]
  } catch {
    return []
  }
}

async function writePublishedIds(ids: string[]) {
  if (sharedStore) {
    await sharedStore.set(PUBLISHED_KEY, ids)
    return
  }

  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true })
  await writeFile(PUBLISHED_FILE, JSON.stringify(ids, null, 2), 'utf-8')
}

export async function getPublishedXIds() {
  return readPublishedIds()
}

export async function markPublishedOnX(postId: string) {
  const ids = await readPublishedIds()
  if (!ids.includes(postId)) await writePublishedIds([postId, ...ids])
  return postId
}

export async function unmarkPublishedOnX(postId: string) {
  const ids = await readPublishedIds()
  const updatedIds = ids.filter((id) => id !== postId)
  if (updatedIds.length !== ids.length) await writePublishedIds(updatedIds)
  return postId
}
