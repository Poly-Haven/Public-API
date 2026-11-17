import '../utils/env.ts'
import cachedFirestore from '../utils/cachedFirestore.ts'

export default async function (fastify) {
  fastify.post('/', async (req, reply) => {
    const key = req.body && req.body.key

    // Refuse outright if the server has no key configured. Without this the comparison below is
    // `undefined !== undefined`, which is false - so a missing DL_KEY would silently turn this into
    // an unauthenticated endpoint that lets anyone flush every node's cache.
    if (!process.env.DL_KEY) {
      console.error('[CLEAR CACHE] DL_KEY is not configured; refusing to clear')
      return reply.code(500).send({
        error: '500 Internal Server Error',
        message: 'Cache clearing is not configured on this node',
      })
    }

    if (key !== process.env.DL_KEY) {
      return reply.code(403).send({
        error: '403 Forbidden',
        message: 'Incorrect key',
      })
    }

    const cleared = cachedFirestore.clearCache()

    return reply.code(200).send({
      message: 'OK',
      node: process.env.NODE_ID || 'UNKNOWN',
      cache: {
        scope: 'local',
        ...cleared,
      },
    })
  })
}
