import type { FastifyReply, FastifyRequest } from 'fastify'

import type { ApiKey } from '../types/firestore.ts'
import { checkKeyLimit, failureBlockedFor, recordKeyFailure } from './keyRateLimit.ts'
import validateKey, { extractKey } from './validateKey.ts'
import { privateNoStore, sendError } from './v2Cache.ts'

// The keyed v2 endpoints (/v2/key, /v2/ea/*) share this preHandler: it validates the Authorization header,
// answers a failure with validateKey's own status and body (never cached, and without the key document that
// the old v2 leaked as `meta.keyData`), counts the request against the key's limits, and leaves what the
// handler needs where `keyAuth(req)` can read it.

export interface KeyAuth {
  /** Whether the key carries early access (Superhive keys always do; patron keys by tier). */
  includeUpcoming: boolean
  keyData: ApiKey
}

const authOf = new WeakMap<FastifyRequest, KeyAuth>()

/** What requireKey worked out for this request. Only call it from a route that has requireKey as its preHandler. */
export const keyAuth = (req: FastifyRequest): KeyAuth => {
  const auth = authOf.get(req)
  if (!auth) throw new Error('keyAuth() called on a request that did not go through requireKey')
  return auth
}

export const requireKey = async (req: FastifyRequest, reply: FastifyReply) => {
  // A client that keeps presenting keys that do not validate is guessing, and every unknown key can cost a
  // billed Firestore read. Once an IP has failed too often it is refused with a 429 instead of its 403, and its
  // lookups stop falling back to Firestore (cacheOnly). A key that validates is never refused here, so a
  // legitimate client behind a shared IP that also has a bad actor on it still gets through.
  const blockedFor = failureBlockedFor(req)
  const validation = await validateKey(req, { cacheOnly: blockedFor > 0 })
  if (!validation.valid) {
    const { status, message } = validation.error
    // 403s only (a 503 is our failing, not the client's), and only when a key was actually presented.
    if (status === 403 && req.headers.authorization) {
      recordKeyFailure(req)
      if (blockedFor > 0) {
        reply.header('Retry-After', String(blockedFor))
        return sendError(reply, 429, `Too many invalid API keys. Try again in ${blockedFor}s.`, { keyed: true })
      }
    }
    return sendError(reply, status, message, { keyed: true })
  }

  const { includeUpcoming, keyData } = validation
  const key = extractKey(req.headers.authorization as string)
  const limit = checkKeyLimit(req, key, keyData.ref)
  if (!limit.allowed) {
    reply.header('Retry-After', String(limit.retryAfter))
    return sendError(reply, 429, `Too many requests for this key. Try again in ${limit.retryAfter}s.`, { keyed: true })
  }

  privateNoStore(reply)
  authOf.set(req, { includeUpcoming, keyData })
}
