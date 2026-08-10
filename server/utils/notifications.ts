import { createHash } from 'node:crypto'
import { getDatabase } from './mongodb'

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

async function notificationsCollection() {
  const collection = (await getDatabase()).collection<UserNotification>('notifications')
  await collection.createIndex({ createdAt: -1 })
  return collection
}

export async function getUserNotifications(user: UserId) {
  return (await notificationsCollection()).find({
    $or: [
      { recipient: user, recipientAcknowledgedAt: { $exists: false } },
      { sender: user, readAt: { $exists: true }, senderAcknowledgedAt: { $exists: false } }
    ]
  }).sort({ createdAt: -1 }).toArray()
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
  await (await notificationsCollection()).insertOne(notification)
  return notification
}

export async function acknowledgeUserNotification(id: string, user: UserId) {
  const collection = await notificationsCollection()
  const notification = await collection.findOne({ id })
  if (!notification) return null
  const now = new Date().toISOString()
  const update = user === notification.recipient && !notification.recipientAcknowledgedAt
    ? { recipientAcknowledgedAt: now, readAt: now }
    : user === notification.sender && notification.readAt && !notification.senderAcknowledgedAt
      ? { senderAcknowledgedAt: now }
      : {}
  if (Object.keys(update).length) await collection.updateOne({ id }, { $set: update })
  const updated = await collection.findOne({ id })
  if (updated?.recipientAcknowledgedAt && updated.senderAcknowledgedAt) await collection.deleteOne({ id })
  return updated || notification
}
