import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { Redis } from '@upstash/redis'

const DATA_DIR = process.env.VERCEL ? join(tmpdir(), 'cortana-data') : join(process.cwd(), 'data')
const NOTIFICATIONS_FILE = join(DATA_DIR, 'notifications.json')
const NOTIFICATIONS_KEY = 'cortana:notifications'

const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
const sharedStore = redisUrl && redisToken
  ? new Redis({ url: redisUrl, token: redisToken })
  : null

export type UserId = '1' | '2'

export interface UserNotification {
  id: string
  sender: UserId
  recipient: UserId
  message: string
  createdAt: string
  readAt?: string
  recipientAcknowledgedAt?: string
  senderAcknowledgedAt?: string
}

async function readNotifications(): Promise<UserNotification[]> {
  if (sharedStore) {
    try {
      return (await sharedStore.get<UserNotification[]>(NOTIFICATIONS_KEY)) || []
    } catch {
      return []
    }
  }

  try {
    if (!existsSync(NOTIFICATIONS_FILE)) return []
    return JSON.parse(await readFile(NOTIFICATIONS_FILE, 'utf-8')) as UserNotification[]
  } catch {
    return []
  }
}

async function writeNotifications(notifications: UserNotification[]) {
  if (sharedStore) {
    await sharedStore.set(NOTIFICATIONS_KEY, notifications)
    return
  }

  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true })
  await writeFile(NOTIFICATIONS_FILE, JSON.stringify(notifications, null, 2), 'utf-8')
}

export async function getUserNotifications(user: UserId) {
  const notifications = await readNotifications()
  return notifications.filter((notification) =>
    (notification.recipient === user && !notification.recipientAcknowledgedAt)
    || (notification.sender === user && notification.readAt && !notification.senderAcknowledgedAt)
  )
}

export async function createUserNotification(sender: UserId, message: string) {
  const recipient: UserId = sender === '1' ? '2' : '1'
  const notification: UserNotification = {
    id: `notification-${createHash('sha1').update(`${sender}-${recipient}-${Date.now()}-${message}`).digest('hex').slice(0, 12)}`,
    sender,
    recipient,
    message,
    createdAt: new Date().toISOString()
  }

  const notifications = await readNotifications()
  await writeNotifications([notification, ...notifications])
  return notification
}

export async function acknowledgeUserNotification(id: string, user: UserId) {
  const notifications = await readNotifications()
  const notification = notifications.find((item) => item.id === id)
  if (!notification) return null

  const now = new Date().toISOString()
  if (user === notification.recipient && !notification.recipientAcknowledgedAt) {
    notification.recipientAcknowledgedAt = now
    notification.readAt = now
  } else if (user === notification.sender && notification.readAt && !notification.senderAcknowledgedAt) {
    notification.senderAcknowledgedAt = now
  }

  const remaining = notifications.filter((item) =>
    !(item.recipientAcknowledgedAt && item.senderAcknowledgedAt)
  )
  await writeNotifications(remaining)
  return notification
}
