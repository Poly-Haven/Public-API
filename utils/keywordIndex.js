const Fuse = require('fuse.js')
const cachedFirestore = require('./cachedFirestore')

/**
 * The keyword half of hybrid search.
 *
 * Deliberately the same engine and the same config polyhaven.com's Grid.tsx has always used, so the
 * keyword lane behaves exactly like the search it is being fused with. Changing these options
 * changes what "keyword match" means for every consumer of /search, not just the website.
 *
 * Its job is not to rank results on its own - the semantic lane does the heavy lifting - but to
 * corroborate. An asset both lanes like beats one only the vectors liked, which is what stops
 * `rocky_terrain_02` sitting fifth for "grass" and what lifts an asset's own name variants.
 */

const FUSE_OPTIONS = {
  keys: ['categories', 'tags', 'name'],
  includeScore: true,
  useExtendedSearch: true,
  threshold: 0.2,
}

// Long, like the vector index: the content only changes on publish, and admin's /clear_cache
// fan-out invalidates both. A short TTL only bought a ~2.8s rebuild in some unlucky user's request.
const TTL = 6 * 60 * 60 * 1000

const db = cachedFirestore()

let index = null
let building = null

const buildIndex = async () => {
  const startedAt = Date.now()
  const collection = await db.collection('assets').get()
  const slugs = []
  const docs = []
  collection.forEach((doc) => {
    const asset = doc.data()
    slugs.push(doc.id)
    // Only the fields Fuse indexes, so the index does not pin a second copy of every asset in
    // memory. `name` is included as-is, and slug matching is handled separately by the exact pin.
    docs.push({
      name: asset.name || '',
      tags: asset.tags || [],
      categories: asset.categories || [],
    })
  })
  const built = {
    fuse: new Fuse(docs, FUSE_OPTIONS),
    slugs,
    count: slugs.length,
    builtAt: Date.now(),
    buildMs: Date.now() - startedAt,
  }
  console.log(`[KEYWORD INDEX] built over ${built.count} assets in ${built.buildMs}ms`)
  return built
}

const isFresh = () => index && Date.now() - index.builtAt < TTL

const getIndex = async () => {
  if (isFresh()) return index
  if (building) return building
  building = (async () => {
    try {
      index = await buildIndex()
      return index
    } finally {
      building = null
    }
  })()
  return building
}

cachedFirestore.onClear(() => {
  index = null
})

// Build shortly after boot rather than inside the first search. app.js has no startup phase, so
// this is deferred rather than awaited - a failure here just means the first search builds it.
setTimeout(() => {
  getIndex().catch((err) => console.error('[KEYWORD INDEX] warm-up failed:', err.message))
}, 10000).unref?.()

/**
 * Fuse's extended-search syntax, applied the way the website has always applied it: a space means
 * OR, a plus means AND. The other operators (^ ! = $ ') are stripped rather than honoured - the
 * website never intended to expose them, and on a public endpoint a stray one is either a parse
 * error or a surprise.
 */
const toExtendedQuery = (query) =>
  String(query)
    .replace(/[\^!=$']/g, '')
    .trim()
    .replace(/\s+/g, '|')
    .replace(/\+/g, ' ')

/**
 * Slugs in keyword-relevance order, best first. Never throws: a query Fuse cannot parse means no
 * keyword opinion, which degrades hybrid search to pure semantic rather than failing the request.
 */
const rank = async (query) => {
  const extended = toExtendedQuery(query)
  if (!extended) return []
  const idx = await getIndex()
  try {
    return idx.fuse.search(extended).map((hit) => idx.slugs[hit.refIndex])
  } catch (err) {
    console.error('[KEYWORD INDEX] search failed for', JSON.stringify(extended), err.message)
    return []
  }
}

const stats = () => {
  if (!index) return { built: false }
  return {
    built: true,
    assets: index.count,
    builtAt: new Date(index.builtAt).toISOString(),
    buildMs: index.buildMs,
    ageSeconds: Math.round((Date.now() - index.builtAt) / 1000),
    fresh: isFresh(),
  }
}

module.exports = { rank, stats, toExtendedQuery, FUSE_OPTIONS }
