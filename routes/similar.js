const escape = require('escape-html')
const express = require('express')
const router = express.Router()

const cachedFirestore = require('../utils/cachedFirestore')
const embeddingIndex = require('../utils/embeddingIndex')
const { vaultIdOf } = require('../utils/assetFilters')
const { upcomingVaultIds } = require('../utils/vaultStatus')

const db = cachedFirestore()

const DEFAULT_NUM = 6
const MAX_NUM = 50

/**
 * How far below the best neighbour's cosine the metadata lane's pick may sit and still be shown.
 * Wide enough for `nqweba_dawn` - a road HDRI filed under Dams & Reservoirs, whose road neighbours
 * sit ~0.17 below its lakeside ones - and no wider.
 */
const RESERVED_MAX_DROP = 0.18

/**
 * And an absolute floor under that, because a model's whole neighbourhood can sit low enough that
 * the relative test admits anything. Everything the relative test let through below this was junk:
 * throw_pillows_01 -> flower_gazania (0.39), ornate_mirror_01 -> sofa_03 (0.48), withered_grass ->
 * grass_concrete_pavement (0.54), which is the keyword failure mode plans/semantic_search.md names
 * by slug.
 */
const RESERVED_MIN_SCORE = 0.6

const termsOf = (asset) => new Set([...(asset.tags || []), ...(asset.categories || [])])

/**
 * Inverse document frequency over tags and legacy categories, across the assets on offer.
 *
 * This is what makes a metadata lane worth having next to the vectors. Counting raw shared terms -
 * what this route did before - gives `outdoor` (1,296 assets) the same vote as `railing` (a
 * handful), so for an HDRI the score is mostly a measure of "also an outdoor daytime HDRI". Once
 * the common terms are discounted, the lane ranks on what actually distinguishes the asset.
 */
const buildIdf = (assets) => {
  const df = new Map()
  for (const asset of assets) {
    for (const term of termsOf(asset)) df.set(term, (df.get(term) || 0) + 1)
  }
  const idf = new Map()
  for (const [term, count] of df) idf.set(term, Math.log(assets.length / count))
  return idf
}

/**
 * Assets ranked by how much distinguishing metadata they share with this one, best first. Ties are
 * broken by cosine rather than by key order - the old ranking's top was a mass of assets on the
 * same integer score, ordered by nothing at all.
 */
const metadataRanking = (this_asset, docs, idf, cosine) => {
  const terms = termsOf(this_asset)
  const ranked = []
  for (const [slug, asset] of Object.entries(docs)) {
    let score = 0
    for (const term of termsOf(asset)) if (terms.has(term)) score += idf.get(term) || 0
    if (score > 0) ranked.push([slug, score])
  }
  ranked.sort((a, b) => b[1] - a[1] || (cosine(b[0]) || 0) - (cosine(a[0]) || 0))
  return ranked
}

/**
 * The pre-embeddings ranking: one point per shared category, one per shared tag.
 *
 * Kept as the fallback for an asset that has no vector - one published in the window before admin
 * writes its embedding, or one whose metadata was too thin to embed at all. On a live asset page,
 * its old tag matches beat an empty strip.
 */
const tagRanking = (this_asset, docs) => {
  const ranked = []
  for (const [slug, asset] of Object.entries(docs)) {
    let score = 0
    for (const cat of asset.categories || []) {
      if ((this_asset.categories || []).includes(cat)) score++
    }
    for (const tag of asset.tags || []) {
      if ((this_asset.tags || []).includes(tag)) score++
    }
    if (score) ranked.push([slug, score])
  }
  return ranked.sort((a, b) => b[1] - a[1])
}

router.get('/', (req, res) => {
  res.status(400).send(`Please format your request as /similar/[asset_id]`)
})

router.get('/:id', async (req, res) => {
  const asset_id = req.params.id

  if (!asset_id) {
    res.status(400).send(`No asset with that ID`)
    return
  }

  const MAX_ID_LENGTH = 50
  if (asset_id.length > MAX_ID_LENGTH) {
    res.status(400).send(`No asset with that ID`)
    return
  }

  const validPattern = /^[a-zA-Z0-9_-]+$/
  if (!validPattern.test(asset_id)) {
    res.status(400).send(`No asset with that ID`)
    return
  }

  // Clamped: every asset now has a score against every other one, so an uncapped `num` would
  // serve the whole library - on a route the edge caches for three days.
  const requested = parseInt(req.query.num, 10)
  const num = Math.min(Math.max(Number.isFinite(requested) ? requested : DEFAULT_NUM, 1), MAX_NUM)

  // Pure vector ranking, for comparing the two. Mirrors /search?hybrid=0.
  const vectorOnly = req.query.lane === 'vector'

  let collectionRef = db.collection('assets')

  const collection = await collectionRef.get()
  let docs = {}
  collection.forEach((doc) => {
    docs[doc.id] = doc.data()
  })

  if (!docs[asset_id]) {
    // This route reads the shared 10-minute collection cache and has no per-document
    // fallback, so a just-created asset is genuinely absent here for a while - and unlike a
    // permanent 404 that one must not be cached. Whether the edge honours this depends on the
    // zone's cache rules, which currently rewrite Cache-Control; the publish purge covers
    // /similar/<slug> either way.
    res.set('Cache-Control', 'no-store')
    res.status(404).send(`No asset with id ${escape(asset_id)}`)
    return
  }
  // Captured before the gates below, so an early-access asset's own page still gets a strip.
  const this_asset = docs[asset_id]

  // Filter what may not be shown. Same gates /assets and /search apply, including the upcoming
  // vaults one: this strip is rendered on a public asset page, so it must not be the place an
  // unannounced vault leaks from.
  const now = Math.floor(Date.now() / 1000)
  const hiddenVaults = await upcomingVaultIds()
  for (const id in docs) {
    if (docs[id].staging || docs[id].date_published > now) {
      delete docs[id]
    } else if (hiddenVaults.size && hiddenVaults.has(vaultIdOf(docs[id]))) {
      delete docs[id]
    }
  }
  delete docs[asset_id]
  const allowed = new Set(Object.keys(docs))

  /**
   * Two lanes, and unlike /search they are not fused.
   *
   * Cosine against the asset's own embedding leads, because it reads the whole of an asset's
   * metadata as meaning rather than as strings - it is what puts `brick_wall_02` on
   * `brick_wall_001` where counting shared tags returned `large_red_bricks`.
   *
   * But it reads the category path and description loudest, which is wrong whenever those describe
   * one facet of an asset and its tags describe another. `nqweba_dawn` is a road-with-backplates
   * HDRI filed under Coast & Water/Rivers & Lakes/Dams & Reservoirs: the vectors return lakeside
   * scenery and bury every road in the library past rank 178.
   *
   * RRF, which /search uses, is the wrong tool for that shape. Fusing these two lanes on
   * `nqweba_dawn` returns neither the lakesides nor the roads but the assets both lanes were
   * lukewarm about - RRF is built to penalise "loved by one lane, ignored by the other", which is
   * exactly the signal worth keeping here. A strip of six tiles does not need one compromise
   * ranking; it can afford to spend a tile on the other lane's best answer.
   *
   * So: the vector ranking fills the strip, and the last slot goes to the metadata lane's top pick
   * - if that pick is still plausibly similar. At most one tile in six differs from the pure vector
   * ranking, and on the assets where the metadata lane has nothing plausible to add, none does.
   */
  const queryVector = await embeddingIndex.getVector(asset_id)
  let ranked
  let reserved = null
  if (queryVector) {
    const { results, scores } = await embeddingIndex.search({
      queryVector,
      isAllowed: (slug) => allowed.has(slug),
    })
    ranked = results

    // Never on a list shorter than the strip's six: one tile in six is the budget, and spending it
    // out of three would make the metadata lane a third of the answer.
    if (!vectorOnly && num >= DEFAULT_NUM && results.length > num) {
      const idf = buildIdf(Object.values(docs))
      const pick = metadataRanking(this_asset, docs, idf, (slug) => scores.get(slug))[0]
      // Measured against the best VECTOR score, which is not necessarily ranked[0] once the
      // puresky pin has moved something with a lower cosine to the front.
      const floor = Math.max(results[0][1] - RESERVED_MAX_DROP, RESERVED_MIN_SCORE)
      if (pick && (scores.get(pick[0]) || 0) >= floor) reserved = [pick[0], scores.get(pick[0])]
    }
  } else {
    ranked = tagRanking(this_asset, docs)
  }

  // The puresky variant is the same shot under a clear sky - always the most useful neighbour an
  // HDRI has, and nothing in the metadata the vectors read says so. Pinned rather than scored, so
  // the similarity reported stays the real one.
  const puresky = asset_id + '_puresky'
  if (allowed.has(puresky)) {
    const pinned = ranked.find(([slug]) => slug === puresky)
    ranked = [pinned || [puresky, null], ...ranked.filter(([slug]) => slug !== puresky)]
  }

  // The reserved slot is spent last, on the full list, so it displaces the weakest tile rather
  // than the puresky pin - and only if the metadata lane's pick is not already on the strip.
  let selected = ranked.slice(0, num)
  if (reserved && !selected.some(([slug]) => slug === reserved[0])) {
    selected = [...ranked.slice(0, num - 1), reserved]
  }

  const similar = {}
  for (const [slug, score] of selected) {
    // Copy before adding similarity. doc.data() hands back the live cached object, so writing to it
    // leaks this request's score into every other route that reads the cached assets collection.
    similar[slug] = { ...docs[slug], similarity: score === null ? null : Math.round(score * 10000) / 10000 }
  }

  res.status(200).json(similar)
})

module.exports = router
