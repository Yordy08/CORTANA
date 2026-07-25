import { getPendingCorrections } from '../../utils/corrections'

export default defineEventHandler(async () => {
  const corrections = await getPendingCorrections()
  return { corrections }
})
