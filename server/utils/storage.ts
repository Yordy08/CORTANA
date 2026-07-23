import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export interface ScrapedPost {
  id: string
  image?: string
  text: string
  fullText?: string
  leadText?: string
  category?: string
  date?: string
  link: string
  mediaType?: 'image' | 'video' | 'text'
  source: 'facebook' | 'web' | 'instagram'
  detectedAt: string
  notified: boolean
}

const DATA_DIR = join(process.cwd(), 'data')
const FACEBOOK_FILE = join(DATA_DIR, 'facebook-posts.json')
const WEB_FILE = join(DATA_DIR, 'web-posts.json')
const INSTAGRAM_FILE = join(DATA_DIR, 'instagram-posts.json')

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true })
  }
}

async function readPosts(filePath: string): Promise<ScrapedPost[]> {
  try {
    if (!existsSync(filePath)) return []
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as ScrapedPost[]
  } catch {
    return []
  }
}

async function writePosts(filePath: string, posts: ScrapedPost[]) {
  await ensureDataDir()
  await writeFile(filePath, JSON.stringify(posts, null, 2), 'utf-8')
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

type Source = 'facebook' | 'web' | 'instagram'

function getSourceFile(source: Source) {
  if (source === 'facebook') return FACEBOOK_FILE
  if (source === 'instagram') return INSTAGRAM_FILE
  return WEB_FILE
}

function getCandidateKey(candidate: { link?: string; image?: string; text?: string; mediaType?: string }, source: Source) {
  const linkKey = normalizeLink(candidate.link)
  if (source === 'facebook' || source === 'instagram') {
    return linkKey || candidate.text?.replace(/\s+/g, ' ').trim().slice(0, 180).toLowerCase() || ''
  }

  return linkKey || candidate.text?.slice(0, 160).toLowerCase() || ''
}

/**
 * Get all stored posts for a given source
 */
export async function getStoredPosts(source: Source): Promise<ScrapedPost[]> {
  return readPosts(getSourceFile(source))
}

/**
 * Check if a post already exists (by link)
 */
export async function hasPost(link: string, source: Source): Promise<boolean> {
  if (!link) return false
  const posts = await getStoredPosts(source)
  const normalizedLink = normalizeLink(link)
  return posts.some((p) => normalizeLink(p.link) === normalizedLink)
}

/**
 * Add new posts that don't exist yet.
 * Returns the list of NEW posts that were added.
 */
export async function addNewPosts(
  candidates: Array<{
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
    // Skip if empty text and no image
    if (!candidate.text && !candidate.image && !candidate.link) continue

    // Deduplicate by source-specific identity. Facebook can expose several media entries with the same post link.
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

        if (changed) await writePosts(getSourceFile(source), posts)
        continue
      }

      // Also check among newPosts being added in this batch
      const alreadyAdded = newPosts.some(
        (p) => getCandidateKey(p, source) === candidateKey
      )
      if (alreadyAdded) continue
    }

    const post: ScrapedPost = {
      id: generateId(candidate.link || candidate.text, source),
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
    await writePosts(getSourceFile(source), [...newPosts, ...posts])
  }

  return newPosts
}

/**
 * Mark posts as notified
 */
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
    await writePosts(getSourceFile(source), posts)
  }
}

