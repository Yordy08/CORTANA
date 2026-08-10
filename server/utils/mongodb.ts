import { createRequire } from 'node:module'
import type { Db, MongoClient } from 'mongodb'

// The MongoDB driver resolves a few optional adapters at runtime. Nitro's
// bundled ESM server does not expose CommonJS `require` by default.
const runtimeRequire = createRequire(import.meta.url)
;(globalThis as typeof globalThis & { require?: typeof runtimeRequire }).require = runtimeRequire

const uri = process.env.MONGODB_URI || process.env.MONGO_URI
const databaseName = process.env.MONGODB_DB_NAME || 'cortana'

let clientPromise: Promise<MongoClient> | null = null

async function getClient(): Promise<MongoClient> {
  if (!uri) {
    throw new Error('MONGODB_URI no está configurada.')
  }

  if (!clientPromise) {
    const { MongoClient } = await import('mongodb')
    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000
    })
    clientPromise = client.connect()
  }

  return clientPromise
}

export async function getDatabase(): Promise<Db> {
  const client = await getClient()
  return client.db(databaseName)
}
