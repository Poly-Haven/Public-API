/**
 * Minimal per-IP sliding-window limiter, in memory.
 *
 * A backstop rather than a wall: Cloudflare absorbs the Zipfian head of search traffic, so anything
 * reaching a node is either a cold query or someone hammering unique ones - and the latter is the
 * only way to spend real Workers AI neurons. Per node, so the effective limit across a two-node
 * fleet is double the number given here.
 *
 * The default has to be generous, because a search box spends requests per KEYSTROKE, not per
 * search. The website's SWR key changes on its 300ms URL debounce with no minimum length, so typing
 * eight characters into the library search fires one request per character - measured at 14 on the
 * dev server, where React strict mode double-invokes, so about 7 in production. A fifteen-character
 * query is therefore ~14 requests, and the earlier 30/min default meant roughly two searches a
 * minute before a legitimate visitor got a 429. A 429 drops them silently to the client-side Fuse
 * fallback with no explanation, and behind CGNAT a whole carrier shares one bucket.
 *
 * 150/min is still a hard ceiling on abuse and costs nothing to allow: it is 2.5 req/s against a
 * measured single-node capacity of 23-45 req/s, and an abuser sitting on the cap with unique queries
 * spends ~216k embeds/day against a free tier that only runs out near 443k. A per-IP limit does
 * nothing about distributed traffic either way, so tightening it only ever hurts real people.
 */
const buckets = new Map()

const DEFAULT_LIMIT = 150

// Bounded so a spray of one-request-each IPs cannot grow the Map without limit.
const MAX_TRACKED_IPS = 20000

const clientIp = (req) => {
  // Behind Cloudflare, so CF-Connecting-IP is the only trustworthy source. req.ip would be the
  // edge's address, which would put every visitor in one bucket.
  const cf = req.headers['cf-connecting-ip']
  if (cf) return cf
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) return String(forwarded).split(',')[0].trim()
  return req.ip || req.socket?.remoteAddress || 'unknown'
}

/**
 * Returns { allowed, remaining, retryAfter }. Call once per request.
 */
const rateLimit = (req, { limit = DEFAULT_LIMIT, windowMs = 60000 } = {}) => {
  const ip = clientIp(req)
  const now = Date.now()

  let hits = buckets.get(ip)
  if (!hits) {
    if (buckets.size >= MAX_TRACKED_IPS) {
      // Drop the oldest-inserted bucket. Crude, but this map only exists to catch abuse, and an
      // abuser stays hot enough to be re-added immediately.
      buckets.delete(buckets.keys().next().value)
    }
    hits = []
    buckets.set(ip, hits)
  }

  // Trim expired hits in place.
  const cutoff = now - windowMs
  while (hits.length && hits[0] <= cutoff) hits.shift()

  if (hits.length >= limit) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((hits[0] + windowMs - now) / 1000) }
  }
  hits.push(now)
  return { allowed: true, remaining: limit - hits.length, retryAfter: 0 }
}

// Periodic sweep, so idle IPs do not sit in the Map until eviction pressure removes them.
setInterval(() => {
  const cutoff = Date.now() - 60000
  for (const [ip, hits] of buckets) {
    while (hits.length && hits[0] <= cutoff) hits.shift()
    if (!hits.length) buckets.delete(ip)
  }
}, 60000).unref?.()

module.exports = { rateLimit, clientIp }
