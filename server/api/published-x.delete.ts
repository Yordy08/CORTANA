import { unmarkPublishedOnX } from '../utils/publishedX'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)

  if (!body.postId) {
    throw createError({ statusCode: 400, statusMessage: 'Falta postId' })
  }

  return { postId: await unmarkPublishedOnX(String(body.postId)) }
})
