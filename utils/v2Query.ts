import type { FastifyRequest } from 'fastify'

/**
 * Whether every querystring value is a plain string. The app parses queries with qs, so `?type[]=x` really
 * arrives as an array and `?a[b]=c` as an object; v1 answers those with a 500 where it trips over them. v2
 * rejects them up front with a 400, which is also what keeps the cache key space (the raw URL) from filling
 * with shapes no handler understands.
 */
export const hasPlainQuery = (req: FastifyRequest): boolean =>
  Object.values(req.query as Record<string, unknown>).every((value) => typeof value === 'string')
