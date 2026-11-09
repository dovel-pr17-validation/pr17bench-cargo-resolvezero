import { createMiddleware, createStart } from '@tanstack/react-start'

/**
 * Reject oversized request bodies before TanStack parses server-function
 * payloads. Keep this small: console writes are tiny JSON objects, while OAuth
 * callbacks are ordinary form posts.
 */
const MAX_BODY_BYTES = 64 * 1024

const bodyLimit = createMiddleware().server(async ({ next, request }) => {
  const rawLength = request.headers.get('content-length')
  if (rawLength) {
    const length = Number(rawLength)
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      throw new Response('Payload too large', { status: 413 })
    }
  }
  return next()
})

export const startInstance = createStart(() => ({
  requestMiddleware: [bodyLimit],
}))
