import { getPublishedXIds } from '../utils/publishedX'

export default defineEventHandler(async () => ({
  postIds: await getPublishedXIds()
}))
