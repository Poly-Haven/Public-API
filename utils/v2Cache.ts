import { STATUS_CODES } from 'node:http'
import type { FastifyReply } from 'fastify'

// Cache policy for the v2 API, in one place.
//
// Cloudflare is configured to respect the origin's Cache-Control on /v2/*, so the TTLs below are what the edge
// really does. That is only safe because nothing cached here can outlive the moment it would stop being true:
// the one thing that changes with the clock is an asset leaving early access, and the only response that
// depends on it is the 403 on /v2/files/:id, whose max-age is capped at the asset's release time. Everything
// else (listings, info, search, similar, categories) includes early-access metadata regardless of the date.
// So no purge-at-release job is needed for v2.
//
// Publishing is what changes the rest, and admin's publish purge (utils/purgeAssetCache.ts) covers the v2 URLs
// as it does v1's. So the TTL matches v1's 12h: each hour shorter is more origin requests from every edge
// location, and the nodes are small.

/** Seconds a public v2 response may be cached for. Same 12h as the zone gives v1. */
export const V2_MAX_AGE = 43200
/** Seconds a 400 or 404 may be cached for: long enough to absorb a hammered bad URL, short enough that a just-published asset appears soon. */
export const V2_ERROR_MAX_AGE = 300
/** Floor for a capped TTL, so an asset about to be released is not re-requested every second. */
export const V2_MIN_MAX_AGE = 60

/**
 * `public, max-age=N` where N is V2_MAX_AGE, capped at the seconds left until `until` (epoch seconds: the next
 * moment this response could change because of an early-access release), with a floor of V2_MIN_MAX_AGE.
 */
export const publicCache = (reply: FastifyReply, { until }: { until?: number } = {}) => {
  let maxAge = V2_MAX_AGE
  if (until !== undefined) {
    const secondsLeft = Math.ceil(until - Date.now() / 1000)
    maxAge = Math.min(V2_MAX_AGE, Math.max(V2_MIN_MAX_AGE, secondsLeft))
  }
  return reply.header('Cache-Control', `public, max-age=${maxAge}`)
}

/** Keyed responses: never stored by a shared cache, and not worth keeping in a browser either. */
export const privateNoStore = (reply: FastifyReply) => reply.header('Cache-Control', 'private, no-store')

export const noStore = (reply: FastifyReply) => reply.header('Cache-Control', 'no-store')

/**
 * The v2 error body, `{ error: '<status> <Reason>', message }`, with the cache header the status calls for
 * unless the caller already set one: 400 and 404 are `public, max-age=300`, everything else `no-store`, and
 * `keyed` always `private, no-store`.
 */
export const sendError = (
  reply: FastifyReply,
  status: number,
  message: string,
  { keyed = false, extra = {} }: { keyed?: boolean; extra?: Record<string, unknown> } = {}
) => {
  if (keyed) {
    privateNoStore(reply)
  } else if (!reply.hasHeader('cache-control')) {
    if (status === 400 || status === 404) reply.header('Cache-Control', `public, max-age=${V2_ERROR_MAX_AGE}`)
    else noStore(reply)
  }
  return reply.code(status).send({ error: `${status} ${STATUS_CODES[status]}`, message, ...extra })
}

/** A Firestore read failed: say so, and make sure nothing caches it. */
export const sendUnavailable = (
  reply: FastifyReply,
  tag: string,
  err: unknown,
  { keyed = false }: { keyed?: boolean } = {}
) => {
  console.error(`[${tag}] Firestore read failed:`, err)
  return sendError(reply, 503, 'Could not look that up right now, please retry in a moment', { keyed })
}

export const sendOk = (reply: FastifyReply, data: unknown) => reply.code(200).send({ message: 'OK', data })
