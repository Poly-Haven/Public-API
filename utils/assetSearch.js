const cachedFirestore = require('./cachedFirestore')
const embeddingIndex = require('./embeddingIndex')
const keywordIndex = require('./keywordIndex')
const rankFusion = require('./rankFusion')
const workersAI = require('./workersAI')

const asset_types = require('../asset_types.json')

const db = cachedFirestore()

const MAX_QUERY_LENGTH = 100

/**
 * Everything below this is noise: the corpus is 2,365 assets and cosine returns all of them ranked,
 * so without a cut every search ships the whole library. Deliberately generous - the "did we find
 * anything at all" decision belongs to the client, which has the hybrid Fuse signal too. See
 * plans/semantic_search.md §2: present and absent concepts overlap on score alone, so a threshold
 * here must not be trusted to mean "no results".
 */
const DEFAULT_MIN_SCORE = 0.35

/**
 * Normalise a query so the in-process cache, the Workers AI call and Cloudflare's cache key all
 * agree. Cloudflare keys on the RAW query string, so this only helps the origin - clients should
 * send an already-canonical query or the edge cache fragments across casings and stray spaces.
 */
const normaliseQuery = (raw) =>
  String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

/**
 * Slugs an unauthenticated caller may see, applying exactly the gates /assets applies:
 *
 *  - `staging`         work in progress, never public.
 *  - `date_published`  in the future = early access. INCLUDED under future=true, because search is
 *                      one of the few things that gets people to discover early-access content and
 *                      support the Patreon. The site does the same and gates only the download.
 *
 * Read from the cached assets collection, so this is fresh within 10 minutes even when the vector
 * index is hours old.
 */
const allowedSlugs = async ({ typeIndex, includeUpcoming, query }) => {
  const collection = await db.collection('assets').get()
  const now = Math.floor(Date.now() / 1000)
  const allowed = new Set()
  // Collected in the same pass rather than from a name Map built per request.
  const exact = []
  collection.forEach((doc) => {
    // Read-only: doc.data() hands back the live cached object shared with every other route.
    const asset = doc.data()
    if (asset.staging) return
    if (!includeUpcoming && asset.date_published > now) return
    if (typeIndex !== null && asset.type !== typeIndex) return
    allowed.add(doc.id)
    if (query && (doc.id.toLowerCase() === query || String(asset.name || '').toLowerCase() === query)) {
      exact.push(doc.id)
    }
  })
  return { allowed, exact }
}

class SearchError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const resolveType = (assetType) => {
  if (!assetType) return null
  if (!(assetType in asset_types)) {
    throw new SearchError(400, `Unsupported asset type. Must be: ${Object.keys(asset_types).join('/')}`)
  }
  return asset_types[assetType]
}

const validateQuery = (raw) => {
  const query = normaliseQuery(raw)
  if (!query) throw new SearchError(400, 'Provide a search query, e.g. /search?q=mossy%20rock&t=textures')
  if (query.length > MAX_QUERY_LENGTH) {
    throw new SearchError(400, `Query too long (${query.length} chars, max ${MAX_QUERY_LENGTH})`)
  }
  return query
}

/**
 * Run a hybrid search. Returns the FULL ranked list rather than a small top-N: the website applies
 * its own filters (author, category, attribute, collection/vault scope) to whatever comes back and
 * shows the count to the user, so a tight cap would quietly change the result counter and could
 * empty out a legitimate filter combination.
 *
 * Two lanes are fused (see utils/rankFusion.js): semantic similarity, and the same Fuse keyword
 * ranking polyhaven.com has always used. The fusion lives here rather than in the website so every
 * consumer - the Blender add-on, any third party - gets the same ranking rather than each
 * reinventing it over a list of slugs.
 */
const runSearch = async ({ query: rawQuery, assetType, includeUpcoming = false, minScore, limit, hybrid = true }) => {
  const typeIndex = resolveType(assetType)
  const query = validateQuery(rawQuery)
  const min = minScore === undefined || minScore === null || minScore === '' ? DEFAULT_MIN_SCORE : Number(minScore)
  if (!Number.isFinite(min) || min < -1 || min > 1) throw new SearchError(400, 'min must be a number between -1 and 1')

  const [queryVector, { allowed, exact }, keywordAll] = await Promise.all([
    workersAI.embedQuery(query).catch((err) => {
      throw new SearchError(503, `Could not embed the query: ${err.message}`)
    }),
    allowedSlugs({ typeIndex, includeUpcoming, query }),
    hybrid ? keywordIndex.rank(query) : Promise.resolve([]),
  ])

  const { results, scores, index } = await embeddingIndex.search({
    queryVector,
    isAllowed: (slug) => allowed.has(slug),
    minScore: min,
  })

  // The keyword lane is gated the same way, and only contributes assets that actually have a vector
  // - anything else could not be scored for the response.
  const keyword = keywordAll.filter((slug) => allowed.has(slug) && scores.has(slug))

  let ranked
  if (hybrid && keyword.length) {
    ranked = rankFusion.fuse([
      { slugs: results.map(([slug]) => slug), weight: rankFusion.WEIGHT_SEMANTIC },
      { slugs: keyword, weight: rankFusion.WEIGHT_KEYWORD },
    ])
  } else {
    // No keyword opinion - a non-Latin query matches nothing in Fuse - so this degrades to pure
    // semantic on its own. That is what keeps multilingual search working without special-casing.
    ranked = results.map(([slug]) => slug)
  }

  ranked = rankFusion.pinExactMatches(ranked, exact)

  const capped = limit ? ranked.slice(0, limit) : ranked

  return {
    query,
    type: assetType || 'all',
    model: index.model,
    minScore: min,
    hybrid: Boolean(hybrid && keyword.length),
    // Count BEFORE any cap, so a client can show an honest result count.
    total: ranked.length,
    // Assets that were eligible at all - lets a caller see when gating, not relevance, emptied it.
    considered: allowed.size,
    // How many the keyword lane contributed, mostly so a surprising ranking can be explained.
    keywordMatches: keyword.length,
    // ORDER IS THE RANKING. `score` is semantic similarity only - it is what `min` filters on and
    // the interpretable number, but it does not by itself explain the order once a keyword match
    // has lifted something.
    results: capped.map((slug) => ({ slug, score: Math.round((scores.get(slug) || 0) * 10000) / 10000 })),
  }
}

module.exports = { runSearch, normaliseQuery, SearchError, MAX_QUERY_LENGTH, DEFAULT_MIN_SCORE }
