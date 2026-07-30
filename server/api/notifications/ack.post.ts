import { acknowledgeUserNotification, type UserId } from '../../utils/notifications'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const user = String(body.user || '') as UserId

  if (!body.id || (user !== '1' && user !== '2')) {
    throw createError({ statusCode: 400, statusMessage: 'Faltan id y usuario' })
  }

  const notification = await acknowledgeUserNotification(String(body.id), user)
  if (!notification) {
    throw createError({ statusCode: 404, statusMessage: 'Notificación no encontrada' })
  }

  return { notification }
})
