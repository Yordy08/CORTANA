import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'

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

const DATA_DIR = process.env.VERCEL ? join(tmpdir(), 'cortana-data') : join(process.cwd(), 'data')
const FACEBOOK_FILE = join(DATA_DIR, 'facebook-posts.json')
const WEB_FILE = join(DATA_DIR, 'web-posts.json')

const memCache = new Map<string, ScrapedPost[]>()
const memCacheTimestamps = new Map<string, number>()

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true })
  }
}

async function readPosts(filePath: string, cacheKey: string): Promise<ScrapedPost[]> {
  const cached = memCache.get(cacheKey)
  if (cached !== undefined) return cached

  try {
    if (!existsSync(filePath)) return []
    const raw = await readFile(filePath, 'utf-8')
    const posts = JSON.parse(raw) as ScrapedPost[]
    memCache.set(cacheKey, posts)
    memCacheTimestamps.set(cacheKey, Date.now())
    return posts
  } catch {
    return []
  }
}

async function writePosts(filePath: string, cacheKey: string, posts: ScrapedPost[]) {
  await ensureDataDir()
  memCache.set(cacheKey, posts)
  memCacheTimestamps.set(cacheKey, Date.now())
  try {
    await writeFile(filePath, JSON.stringify(posts, null, 2), 'utf-8')
  } catch {
    // In Vercel serverless, /tmp might be read-only for some tiers
    // In-memory cache still works for warm instances
  }
}

function normalizeLink(link = ''): string {
  if (!link.trim()) return ''

  try {
    const url = new URL(link)
    url.hash = ''
    for (const key of Array.from(url.searchParams.keys())) {
      if (key.startsWith('__') || key.startsWith('utm_') || key === 'fbclid') {
        url.searchParams.delete(key)
      }
    }
    return url.toString().toLowerCase()
  } catch {
    return link.trim().toLowerCase()
  }
}

function generateId(link: string, source: string): string {
  const key = normalizeLink(link) || link.trim().toLowerCase()
  const hash = createHash('sha1').update(key || `${Date.now()}-${Math.random()}`).digest('hex')
  return `${source}-${hash}`
}

type Source = 'facebook' | 'web'

function getSourceFile(source: Source) {
  if (source === 'facebook') return FACEBOOK_FILE
  return WEB_FILE
}

function getCacheKey(source: Source) {
  return source === 'facebook' ? 'fb' : 'web'
}

function getCandidateKey(candidate: { link?: string; image?: string; text?: string; mediaType?: string }, source: Source) {
  const linkKey = normalizeLink(candidate.link)
  if (source === 'facebook') {
    return linkKey || candidate.text?.replace(/\s+/g, ' ').trim().slice(0, 180).toLowerCase() || ''
  }

  return linkKey || candidate.text?.slice(0, 160).toLowerCase() || ''
}

export async function getStoredPosts(source: Source): Promise<ScrapedPost[]> {
  return readPosts(getSourceFile(source), getCacheKey(source))
}

export async function hasPost(link: string, source: Source): Promise<boolean> {
  if (!link) return false
  const posts = await getStoredPosts(source)
  const normalizedLink = normalizeLink(link)
  return posts.some((p) => normalizeLink(p.link) === normalizedLink)
}

export async function addNewPosts(
  candidates: Array<{
    title?: string
    image?: string
    text: string
    fullText?: string
    leadText?: string
    category?: string
    date?: string
    link: string
    mediaType?: 'image' | 'video' | 'text'
  }>,
  source: Source
): Promise<ScrapedPost[]> {
  const posts = await getStoredPosts(source)
  const newPosts: ScrapedPost[] = []

  for (const candidate of candidates) {
    if (!candidate.text && !candidate.image && !candidate.link) continue

    const candidateKey = getCandidateKey(candidate, source)

    if (candidateKey) {
      const existingPost = posts.find(
        (p) => getCandidateKey(p, source) === candidateKey
      )
      if (existingPost) {
        let changed = false

        if (candidate.text && candidate.text.length > existingPost.text.length) {
          existingPost.text = candidate.text
          changed = true
        }
        if (candidate.title && existingPost.title !== candidate.title) {
          existingPost.title = candidate.title
          changed = true
        }
        if (candidate.fullText && existingPost.fullText !== candidate.fullText) {
          existingPost.fullText = candidate.fullText
          changed = true
        }
        if (candidate.leadText && existingPost.leadText !== candidate.leadText) {
          existingPost.leadText = candidate.leadText
          changed = true
        }
        if (candidate.category && existingPost.category !== candidate.category) {
          existingPost.category = candidate.category
          changed = true
        }
        if (candidate.image && existingPost.image !== candidate.image) {
          existingPost.image = candidate.image
          changed = true
        }
        if (candidate.date && existingPost.date !== candidate.date) {
          existingPost.date = candidate.date
          changed = true
        }

        if (changed) await writePosts(getSourceFile(source), getCacheKey(source), posts)
        continue
      }

      const alreadyAdded = newPosts.some(
        (p) => getCandidateKey(p, source) === candidateKey
      )
      if (alreadyAdded) continue
    }

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

    newPosts.push(post)
  }

  if (newPosts.length > 0) {
    await writePosts(getSourceFile(source), getCacheKey(source), [...newPosts, ...posts])
  }

  return newPosts
}

export async function markNotified(postIds: string[], source: Source) {
  const posts = await getStoredPosts(source)
  let changed = false

  for (const id of postIds) {
    const post = posts.find((p) => p.id === id)
    if (post && !post.notified) {
      post.notified = true
      changed = true
    }
  }

  if (changed) {
    await writePosts(getSourceFile(source), getCacheKey(source), posts)
  }
}
