const express = require('express')
const router = express.Router()

const { runSearch, SearchError } = require('../../utils/assetSearch')
const { rateLimit } = require('../../utils/rateLimit')
const validateKey = require('../../utils/validateKey')

/**
 * Key-gated semantic search, over the same index as /search.
 *
 * GET /v2/search?q=mossy+rock&t=textures    Authorization: Bearer <key>
 *
 * The difference from v1 is only how early access is decided: v1 takes the keyless ?future=true
 * that /assets has always accepted, while this reads it from the key itself. When v2 tokens
 * eventually replace ?future=true, search does not need a separate migration.
 *
 * Not edge-cached: the response varies per key, exactly like /v2/assets. That is also why this
 * needs its own rate limit where /v2/assets does not - every request here reaches the node and
 * embeds a query, with no edge in front to absorb repeats.
 */
router.get('/', async (req, res) => {
  const limiter = rateLimit(req)
  if (!limiter.allowed) {
    res.set('Retry-After', String(limiter.retryAfter))
    return res.status(429).json({
      error: '429',
      message: `Too many searches. Try again in ${limiter.retryAfter}s.`,
    })
  }

  const keyValidation = await validateKey(req)
  if (!keyValidation.valid) {
    return res.status(keyValidation.error.status).json({
      error: keyValidation.error.error,
      message: keyValidation.error.message,
      meta: {
        keyData: keyValidation.keyData,
      },
    })
  }

  const { includeUpcoming, keyData } = keyValidation

  try {
    const result = await runSearch({
      query: req.query.q || req.query.query,
      assetType: req.query.type || req.query.t,
      includeUpcoming,
      minScore: req.query.min,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 0,
      // hybrid=0 gives the pure semantic ranking, for comparing the fusion against the vectors alone.
      hybrid: req.query.hybrid !== '0' && req.query.hybrid !== 'false',
    })
    // Same signal /v2/assets sends, so a client (e.g. the Blender add-on) can tell whether its key
    // is an early-access one without a second request.
    res.set('x-ph-early-access', includeUpcoming ? 'true' : 'false')
    return res.status(200).json({
      message: 'OK',
      data: result,
      meta: {
        includeUpcoming,
        keyData,
      },
    })
  } catch (err) {
    if (err instanceof SearchError) {
      return res.status(err.status).json({ error: `${err.status}`, message: err.message })
    }
    console.error('[V2 SEARCH] failed:', err)
    return res.status(500).json({ error: '500', message: 'Search is temporarily unavailable' })
  }
})

module.exports = router
