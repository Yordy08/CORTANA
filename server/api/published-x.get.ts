import { getDailyPublishedCount, getPublishedXIds } from '../utils/publishedX'

export default defineEventHandler(async () => ({
  postIds: await getPublishedXIds(),
  dailyCount: await getDailyPublishedCount()
}))
