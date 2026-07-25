import { resolveCorrection } from '../../utils/corrections'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)

  if (!body.correctionId) {
    throw createError({ statusCode: 400, statusMessage: 'Falta correctionId' })
  }

  const result = await resolveCorrection(body.correctionId)

  if (!result) {
    throw createError({ statusCode: 404, statusMessage: 'Correccion no encontrada o ya resuelta' })
  }

  return result
})
