import type { FastifyRequest } from 'fastify'
import { clientIp } from './rateLimit.ts'

// Per-API-key limits for the keyed v2 endpoints, in memory (per node, like utils/rateLimit.ts).
//
// Two things, both aimed at a key being shared or scraped rather than at ordinary use:
//
//  - A token bucket per key: 300 requests of burst, refilling at 60 a minute. Log-only until
//    KEY_RATE_LIMIT_ENFORCE=1, so the real traffic can be looked at before anyone is refused.
//  - Distinct client IPs per key per UTC day, warning as a key crosses 5, 10, 20 and 50. A key in the hands of
//    one person is on one or two IPs; fifty means it has been published somewhere.
//
// Nothing is written to Firestore, and a key is only ever logged by its `ref` (or its first 8 characters).

const CAPACITY = 300
const REFILL_PER_SECOND = 60 / 60
const WARN_EVERY_MS = 60_000
const IP_THRESHOLDS = [5, 10, 20, 50]
// Bounded so a spray of made-up keys cannot grow the maps without limit. Only valid keys get this far, so this
// is a backstop rather than a number anyone will meet.
const MAX_TRACKED_KEYS = 10_000
const MAX_IPS_PER_KEY = Math.max(...IP_THRESHOLDS) + 10

interface Bucket {
  tokens: number
  updated: number
  lastWarn: number
}
const buckets = new Map<string, Bucket>()

let ipDay = ''
const ipsByKey = new Map<string, Set<string>>()

const evictOldest = (map: Map<string, unknown>) => {
  if (map.size >= MAX_TRACKED_KEYS) map.delete(map.keys().next().value as string)
}

/** What to call a key in a log line. */
const label = (key: string, ref?: string) => ref || key.slice(0, 8)

export interface KeyLimitResult {
  allowed: boolean
  retryAfter: number
}

/**
 * Counts one request against `key` and its client IP. Over the bucket's limit the request is refused
 * (allowed: false, with retryAfter in seconds) only when KEY_RATE_LIMIT_ENFORCE is '1'; otherwise it is allowed
 * and a warning is logged at most once a minute per key.
 */
export const checkKeyLimit = (req: FastifyRequest, key: string, ref?: string): KeyLimitResult => {
  const now = Date.now()
  const name = label(key, ref)

  // Distinct IPs today.
  const day = new Date(now).toISOString().slice(0, 10)
  if (day !== ipDay) {
    ipDay = day
    ipsByKey.clear()
  }
  let ips = ipsByKey.get(key)
  if (!ips) {
    evictOldest(ipsByKey)
    ips = new Set()
    ipsByKey.set(key, ips)
  }
  const ip = clientIp(req)
  if (!ips.has(ip) && ips.size < MAX_IPS_PER_KEY) {
    ips.add(ip)
    if (IP_THRESHOLDS.includes(ips.size)) console.warn(`[KEY IPS] ${name} reached ${ips.size} distinct IPs today`)
  }

  // Token bucket.
  let bucket = buckets.get(key)
  if (!bucket) {
    evictOldest(buckets)
    bucket = { tokens: CAPACITY, updated: now, lastWarn: 0 }
    buckets.set(key, bucket)
  }
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + ((now - bucket.updated) / 1000) * REFILL_PER_SECOND)
  bucket.updated = now

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return { allowed: true, retryAfter: 0 }
  }

  if (process.env.KEY_RATE_LIMIT_ENFORCE === '1') {
    return { allowed: false, retryAfter: Math.ceil((1 - bucket.tokens) / REFILL_PER_SECOND) }
  }
  if (now - bucket.lastWarn >= WARN_EVERY_MS) {
    bucket.lastWarn = now
    console.warn(`[KEY RATE] ${name} over limit`)
  }
  return { allowed: true, retryAfter: 0 }
}

/** For tests. */
export const resetKeyLimits = () => {
  buckets.clear()
  ipsByKey.clear()
  ipDay = ''
}
