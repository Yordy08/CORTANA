type WordPressPageCache<T> = {
  body: T
  etag?: string
  lastModified?: string
  totalPages?: string
  expiresAt: number
}

const CACHE_TTL_MS = 45_000
const pages = new Map<string, WordPressPageCache<unknown>>()

export function getWordPressPageCache<T>(key: string) {
  return pages.get(key) as WordPressPageCache<T> | undefined
}

export function setWordPressPageCache<T>(key: string, value: Omit<WordPressPageCache<T>, 'expiresAt'>) {
  pages.set(key, { ...value, expiresAt: Date.now() + CACHE_TTL_MS })
}
