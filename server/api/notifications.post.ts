import { createUserNotification, type UserId } from '../utils/notifications'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const sender = String(body.sender || '') as UserId
  const message = String(body.message || '').trim()

  if ((sender !== '1' && sender !== '2') || !message) {
    throw createError({ statusCode: 400, statusMessage: 'Faltan usuario y mensaje' })
  }

  return { notification: await createUserNotification(sender, message) }
})
