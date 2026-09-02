const firestore = require('../firestore')
const cachedFirestore = require('./cachedFirestore')

/**
 * In-memory vector index for /search, built from the `asset_embeddings` collection.
 *
 * Read with the DIRECT client rather than cachedFirestore, for two reasons: it wants a much longer
 * TTL than the 10-minute assets cache (vectors only change when an asset is published or its
 * metadata edited), and cachedFirestore is capped at 10 collections with 8 already in use.
 *
 * The vectors are all this holds. Everything needed to GATE a result - type, staging,
 * date_published, vault - comes from the existing cached `assets` collection at query time, so
 * publication state is never more than 10 minutes stale even though the vectors are hours old.
 *
 * Built lazily, with a deferred warm-up shortly after boot so a cold node does not make its first
 * searcher wait. app.js has no startup phase - routes register inside an async readdir callback
 * while listen() runs synchronously - so the warm-up is a timer rather than an awaited step.
 */

const DIMS = 1024
const TTL = 6 * 60 * 60 * 1000

let index = null
let building = null
let generation = 0

const buildIndex = async () => {
  const startedAt = Date.now()
  const db = firestore()
  const snap = await db.collection('asset_embeddings').get()

  const slugs = []
  const vectors = new Int8Array(snap.size * DIMS)
  const invNorms = new Float32Array(snap.size)
  let i = 0
  let skipped = 0
  let model = null

  snap.forEach((doc) => {
    const data = doc.data()
    const buf = data.v
    // A wrong-length blob means a half-written or foreign document. Skipping it loses one asset
    // from search rather than shifting every subsequent vector by a few bytes.
    if (!buf || buf.length !== DIMS) {
      skipped++
      return
    }
    const offset = i * DIMS
    let sumSquares = 0
    for (let k = 0; k < DIMS; k++) {
      const value = buf.readInt8(k)
      vectors[offset + k] = value
      sumSquares += value * value
    }
    // The stored vectors are int8 quantisations of unit vectors, so their norms are close to but not
    // exactly equal. Dividing by the real norm keeps cosine exact instead of approximately right.
    invNorms[i] = sumSquares > 0 ? 1 / Math.sqrt(sumSquares) : 0
    slugs.push(doc.id)
    if (!model) model = data.model || null
    i++
  })

  const built = {
    slugs,
    vectors,
    invNorms,
    count: i,
    skipped,
    model,
    builtAt: Date.now(),
    buildMs: Date.now() - startedAt,
    generation: ++generation,
  }
  console.log(
    `[SEARCH INDEX] built ${built.count} vectors in ${built.buildMs}ms` + (skipped ? ` (${skipped} skipped)` : '')
  )
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

const invalidate = () => {
  if (index) console.log(`[SEARCH INDEX] invalidated (${index.count} vectors, generation ${index.generation})`)
  index = null
}

// admin POSTs /clear_cache to every node on publish. Rebuilding on the next search rather than
// immediately keeps the publish request fast and avoids two nodes racing to rebuild.
cachedFirestore.onClear(invalidate)

// Same reasoning as the keyword index: build shortly after boot so a cold node does not make its
// first searcher wait for it.
setTimeout(() => {
  getIndex().catch((err) => console.error('[SEARCH INDEX] warm-up failed:', err.message))
}, 10000).unref?.()

/**
 * Score a normalised query vector against the index.
 *
 * `isAllowed(slug)` applies the caller's publication gates - it runs before the dot product, so a
 * gated-out asset costs nothing and cannot occupy a slot in the result set.
 */
const search = async ({ queryVector, isAllowed, minScore = 0 }) => {
  const idx = await getIndex()
  const results = []
  // Every gated asset's similarity, not just the ones above the floor. Hybrid search can surface an
  // asset on the strength of a keyword match alone, and the response still has to report a
  // similarity for it.
  const scores = new Map()
  for (let i = 0; i < idx.count; i++) {
    const slug = idx.slugs[i]
    if (isAllowed && !isAllowed(slug)) continue
    const offset = i * DIMS
    let dot = 0
    for (let k = 0; k < DIMS; k++) dot += queryVector[k] * idx.vectors[offset + k]
    const score = dot * idx.invNorms[i]
    scores.set(slug, score)
    if (score >= minScore) results.push([slug, score])
  }
  results.sort((a, b) => b[1] - a[1])
  return { results, scores, index: idx }
}

const stats = () => {
  if (!index) return { built: false }
  return {
    built: true,
    vectors: index.count,
    skipped: index.skipped,
    model: index.model,
    builtAt: new Date(index.builtAt).toISOString(),
    buildMs: index.buildMs,
    ageSeconds: Math.round((Date.now() - index.builtAt) / 1000),
    generation: index.generation,
    fresh: isFresh(),
  }
}

module.exports = { search, getIndex, invalidate, stats, DIMS }
