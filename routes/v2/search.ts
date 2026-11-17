import type { FastifyInstance } from 'fastify'

import type { Query } from '../../types/http.ts'
import { runSearch, SearchError } from '../../utils/assetSearch.ts'
import { rateLimit } from '../../utils/rateLimit.ts'
import { publicCache, sendError, sendOk } from '../../utils/v2Cache.ts'
import { hasPlainQuery } from '../../utils/v2Query.ts'

/**
 * GET /v2/search?q=mossy+rock&t=textures: /search as v1 answers it with ?future=true (early-access assets are
 * searchable, because finding them is how people end up supporting the project), wrapped in `{message, data}`
 * as the old v2 search was. Keyless and the same for everyone, so the edge caches it by URL.
 *
 * The per-IP limiter stays as the backstop it is in v1: a cold query spends a Workers AI embedding, and the
 * edge only absorbs repeats.
 */
export default async function (fastify: FastifyInstance) {
  fastify.get<{ Querystring: Query }>('/', async (req, reply) => {
    const limiter = rateLimit(req)
    if (!limiter.allowed) {
      reply.header('Retry-After', String(limiter.retryAfter))
      return sendError(reply, 429, `Too many searches. Try again in ${limiter.retryAfter}s.`)
    }
    if (!hasPlainQuery(req)) return sendError(reply, 400, 'Query parameters must be plain values')

    try {
      const result = await runSearch({
        query: req.query.q || req.query.query,
        assetType: req.query.type || req.query.t,
        includeUpcoming: true,
        minScore: req.query.min,
        // Clamped as in v1: slice(0, -50) would drop the BEST matches.
        limit: Math.max(0, parseInt(String(req.query.limit), 10) || 0),
        // hybrid=0 gives the pure semantic ranking, for comparing the fusion against the vectors alone.
        hybrid: req.query.hybrid !== '0' && req.query.hybrid !== 'false',
      })
      publicCache(reply)
      return sendOk(reply, result)
    } catch (err) {
      // Bad input (400) is cacheable like any other; a failure to embed the query (503) is not.
      if (err instanceof SearchError) return sendError(reply, err.status, err.message)
      console.error('[V2 SEARCH] failed:', err)
      return sendError(reply, 500, 'Search is temporarily unavailable')
    }
  })
}
