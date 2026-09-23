const escape = require('escape-html')
const express = require('express')
const router = express.Router()

const { runSearch, SearchError } = require('../utils/assetSearch')
const { rateLimit } = require('../utils/rateLimit')

/**
 * Semantic search over asset metadata. See plans/semantic_search.md in the admin repo.
 *
 * GET /search?q=mossy+rock&t=textures
 *
 * Returns the full ranked list of matching slugs with scores, most relevant first - not a small
 * top-N. Callers are expected to intersect it with whatever they already hold (the website narrows
 * by collection, vault, category, attribute and author client-side) and to show `total` as the
 * result count.
 *
 * Early access: assets whose date_published is in the future are INCLUDED with ?future=true, the
 * same keyless opt-in /assets has. Search is a discovery route for early-access content, not a
 * thing to hide it from. Staging assets are always excluded.
 *
 * Cached for 12 hours, matching /info and /files. Measured against the live zone rather than
 * assumed: any origin max-age below 43200 is rewritten to exactly 43200 and the other directives
 * are dropped, while 43200 or above passes through verbatim (checked on /extensions 3600,
 * /patrons_top 1800 and /stats/taxonomy 3600, all of which reach the browser as 43200). So a
 * shorter header here would not have produced a shorter cache, only a misleading comment.
 *
 * The one thing to know: /assets is purged on publish, this is not and cannot be. The Pro plan
 * purges by exact URL and the query space here is unbounded, so a newly published asset joins
 * cached result sets within an edge TTL rather than immediately. It is browsable and in /assets
 * straight away, just not yet findable by a search someone else already ran. Publishing is roughly
 * daily, so that is a known and accepted cost of not paying for wildcard purge. If it ever matters,
 * the fix is a corpus version in the cache key (&v=<hash>) so a publish changes the key space.
 */
router.get('/', async (req, res) => {
  const limiter = rateLimit(req)
  if (!limiter.allowed) {
    res.set('Retry-After', String(limiter.retryAfter))
    res.status(429).send(`Too many searches. Try again in ${limiter.retryAfter}s.`)
    return
  }

  try {
    const result = await runSearch({
      query: req.query.q || req.query.query,
      assetType: req.query.type || req.query.t,
      includeUpcoming: Boolean(req.query.future),
      minScore: req.query.min,
      // Clamped: slice(0, -50) would drop the BEST matches and report a total that disagrees with
      // results.length. No caller sends a negative limit, but this is a documented public endpoint
      // and a client generated from the spec could.
      limit: Math.max(0, parseInt(req.query.limit, 10) || 0),
      // hybrid=0 gives the pure semantic ranking, for comparing the fusion against the vectors alone.
      hybrid: req.query.hybrid !== '0' && req.query.hybrid !== 'false',
    })
    res.set('Cache-Control', 'public, max-age=43200, s-maxage=43200, stale-while-revalidate=86400')
    res.status(200).json(result)
  } catch (err) {
    if (err instanceof SearchError) {
      res.status(err.status).send(escape(err.message))
      return
    }
    console.error('[SEARCH] failed:', err)
    res.status(500).send('Search is temporarily unavailable')
  }
})

module.exports = router
