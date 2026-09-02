/**
 * Reciprocal Rank Fusion - combines the semantic and keyword rankings into one.
 *
 * Scores from the two lanes are not comparable: Fuse gives a fuzzy distance in 0..1 where lower is
 * better, cosine gives roughly 0.3..0.7 where higher is better, and the cosine range shifts per
 * query and per language (German runs 0.04-0.23 below English for the same concept). Normalising
 * two scales like that is fragile. RRF ignores the scores entirely and uses only POSITION, so an
 * asset's contribution from each lane is 1/(K + rank).
 *
 * The effect is that agreement wins: something both lanes rank highly beats something only one of
 * them liked. Concretely, for "grass" it drops `rocky_terrain_02` (semantic #5, keyword #16) below
 * `grass_path_3` (semantic #3, keyword #5).
 *
 * Cormack, Clarke & Buettcher (2009). K=60 is the constant from that paper and the value every
 * implementation uses. It flattens the top of each list so no single lane can dominate on its #1
 * alone.
 */

const K = 60

// The semantic lane leads and the keyword lane corroborates. Weighting them equally lets Fuse pull
// its own #1 to the top of a query it is bad at - `grass_concrete_pavement` for "grass" is a
// concrete texture with grass in the name, which is exactly the keyword failure mode being replaced.
const WEIGHT_SEMANTIC = 2
const WEIGHT_KEYWORD = 1

/**
 * @param lanes  [{ slugs: string[], weight: number }] - each already in its own best-first order
 * @returns      slugs in fused order, best first
 */
const fuse = (lanes) => {
  const scores = new Map()
  for (const lane of lanes) {
    const weight = lane.weight === undefined ? 1 : lane.weight
    lane.slugs.forEach((slug, i) => {
      scores.set(slug, (scores.get(slug) || 0) + weight / (K + i + 1))
    })
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([slug]) => slug)
}

/**
 * An exact slug or name match goes first, whatever the fusion thought.
 *
 * RRF alone gets this wrong in a specific and unacceptable way: searching `qwantani` drops the asset
 * literally called qwantani out of the top five, because it is #1 for keyword but far down for
 * semantics, and RRF penalises exactly that shape - loved by one lane, ignored by the other. The pin
 * is narrow on purpose. Pinning every slug that merely STARTS WITH the term instead put
 * `grass_concrete_pavement` above `leafy_grass`, which is the keyword behaviour this replaces.
 */
const pinExactMatches = (slugs, exactSlugs) => {
  if (!exactSlugs || !exactSlugs.length) return slugs
  const pin = new Set(exactSlugs)
  const head = slugs.filter((slug) => pin.has(slug))
  if (!head.length) return slugs
  return [...head, ...slugs.filter((slug) => !pin.has(slug))]
}

module.exports = { fuse, pinExactMatches, K, WEIGHT_SEMANTIC, WEIGHT_KEYWORD }
