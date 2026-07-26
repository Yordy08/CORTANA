import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { getStoredPosts, type ScrapedPost } from './storage'

const DATA_DIR = process.env.VERCEL ? join(tmpdir(), 'cortana-data') : join(process.cwd(), 'data')
const CORRECTIONS_FILE = join(DATA_DIR, 'corrections.json')

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

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true })
  }
}

async function readCorrections(): Promise<PostCorrection[]> {
  try {
    if (!existsSync(CORRECTIONS_FILE)) return []
    const raw = await readFile(CORRECTIONS_FILE, 'utf-8')
    return JSON.parse(raw) as PostCorrection[]
  } catch {
    return []
  }
}

async function writeCorrections(corrections: PostCorrection[]) {
  await ensureDataDir()
  await writeFile(CORRECTIONS_FILE, JSON.stringify(corrections, null, 2), 'utf-8')
}

export async function getPendingCorrections(): Promise<PostCorrection[]> {
  const all = await readCorrections()
  let changed = false

  for (const correction of all) {
    if (correction.status !== 'pending') continue

    const posts = await getStoredPosts(correction.source)
    const post = posts.find((item) => item.id === correction.postId)
    const currentValue = correction.field === 'category'
      ? post?.category
      : correction.field === 'title'
        ? post?.leadText
        : undefined

    if (currentValue && currentValue.trim() === correction.suggestedValue.trim()) {
      correction.status = 'done'
      correction.resolvedAt = new Date().toISOString()
      changed = true
    }
  }

  if (changed) await writeCorrections(all)
  return all.filter((c) => c.status === 'pending')
}

export async function getAllCorrections(): Promise<PostCorrection[]> {
  return readCorrections()
}

export async function createCorrection(correction: {
  postId: string
  source: 'facebook' | 'web'
  field: string
  currentValue: string
  suggestedValue: string
}): Promise<PostCorrection> {
  const all = await readCorrections()

  const existing = all.find(
    (c) => c.postId === correction.postId && c.field === correction.field && c.status === 'pending'
  )
  if (existing) return existing

  const id = `corr-${createHash('sha1').update(`${correction.postId}-${correction.field}-${Date.now()}`).digest('hex').slice(0, 12)}`

  const newCorrection: PostCorrection = {
    id,
    ...correction,
    status: 'pending',
    createdAt: new Date().toISOString()
  }

  await writeCorrections([newCorrection, ...all])
  return newCorrection
}

export async function resolveCorrection(correctionId: string): Promise<{ correction: PostCorrection; updatedPost?: ScrapedPost } | null> {
  const all = await readCorrections()
  const idx = all.findIndex((c) => c.id === correctionId)
  if (idx === -1 || all[idx].status === 'done') return null

  all[idx].status = 'done'
  all[idx].resolvedAt = new Date().toISOString()
  const resolved = all[idx]

  await writeCorrections(all)

  const posts = await getStoredPosts(resolved.source)
  const postIdx = posts.findIndex((p) => p.id === resolved.postId)
  if (postIdx === -1) return { correction: resolved }

  const post = posts[postIdx]
  if (resolved.field === 'category') {
    post.category = resolved.suggestedValue
  } else if (resolved.field === 'title') {
    post.leadText = resolved.suggestedValue
  }

  const filePath = resolved.source === 'facebook'
    ? join(DATA_DIR, 'facebook-posts.json')
    : join(DATA_DIR, 'web-posts.json')

  await writeFile(filePath, JSON.stringify(posts, null, 2), 'utf-8')

  return { correction: resolved, updatedPost: post }
}
