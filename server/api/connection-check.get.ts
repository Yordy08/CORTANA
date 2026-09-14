export default defineEventHandler((event) => {
  setHeader(event, 'cache-control', 'no-store, no-cache, must-revalidate')
  setHeader(event, 'content-type', 'text/plain; charset=utf-8')
  return 'ok'
})
