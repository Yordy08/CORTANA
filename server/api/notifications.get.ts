import { getUserNotifications, type UserId } from '../utils/notifications'

export default defineEventHandler(async (event) => {
  const user = String(getQuery(event).user || '') as UserId
  if (user !== '1' && user !== '2') {
    throw createError({ statusCode: 400, statusMessage: 'Usuario inválido' })
  }

  return { notifications: await getUserNotifications(user) }
})
