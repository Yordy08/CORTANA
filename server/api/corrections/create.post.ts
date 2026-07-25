import { createCorrection } from '../../utils/corrections'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)

  if (!body.postId || !body.source || !body.field || !body.suggestedValue) {
    throw createError({ statusCode: 400, statusMessage: 'Faltan campos requeridos: postId, source, field, suggestedValue' })
  }

  if (body.source !== 'facebook' && body.source !== 'web') {
    throw createError({ statusCode: 400, statusMessage: 'source debe ser "facebook" o "web"' })
  }

  const correction = await createCorrection({
    postId: body.postId,
    source: body.source,
    field: body.field,
    currentValue: body.currentValue || '',
    suggestedValue: body.suggestedValue
  })

  return { correction }
})
