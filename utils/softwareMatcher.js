const catalog = require('../constants/software.json')

/**
 * Turns the free-text `software` field on a gallery submission into a set of known software.
 *
 * The field has been three different things over the years: a plain text box (2018-2021), the same
 * box with a 32-character limit, and today a multi-select whose options are a short curated list
 * with free entry still allowed. So one artwork's answer might be `["blender", "cycles"]` and
 * another's `"3dsMax, Corona, Substance Painte"` - truncated mid-word by that old limit.
 *
 * Matching happens in three widening steps, each only reached if the previous one found nothing:
 *
 * 1. Split the answer into segments. Separators are punctuation and joining words, but hyphenated
 *    product names are collapsed first (`V-Ray` -> `vray`) so the hyphen is free to be a separator -
 *    `3dsmax-corona-photoshop` is a real answer and so is `V-Ray`.
 * 2. Match each segment against the catalog, on a squashed form with all punctuation removed. That
 *    collapses `3ds Max`, `3dsMax` and `3DS-MAX` onto one key, and lets a version suffix ride along
 *    harmlessly: `blender 2.82` still contains `blender`. Aliases shorter than a product name
 *    (`ps`, `max`, `oc`) would fire inside unrelated words as substrings, so those are listed under
 *    `token` and only match a whole word, after any trailing version number is stripped.
 * 3. Resolve truncations. Only for answers long enough to have hit the old 32-character limit, and
 *    only on the final segment: if it is a prefix of exactly one product's alias, it is that
 *    product. `substance painte`, `corona rende`, `photos` and `redsh` are all this.
 *
 * Ties in step 3 are broken by how often each candidate was matched outright elsewhere, which is why
 * this exports a two-pass API rather than a single function: `parse` every artwork first, then
 * `resolve` the leftovers once the strict counts are known. `subst` picks Substance Painter over
 * Designer because the corpus says Painter is ten times more common, not because it is hardcoded to.
 */

const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const wordsOf = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
// `max2019` -> `max`, `keyshot9` -> `keyshot`. Falls back to the original so a bare `2019` survives
// as itself rather than becoming an empty string.
const deversion = (t) => t.replace(/[0-9.]+$/, '') || t

// Collapsed before the split, because every one of these contains a character that is otherwise a
// separator. Anything not listed here loses its hyphen to the splitter, which is what we want.
const PROTECTED = [
  [/v\s*-\s*ray/g, 'vray'],
  [/3d\s*-\s*coat/g, '3dcoat'],
  [/after\s*-\s*effects/g, 'aftereffects'],
  [/x\s*-\s*particles/g, 'xparticles'],
  [/paint\.net/g, 'paintnet'],
  [/e\s*-\s*on/g, 'eon'],
]

// `.` is a separator because `3dsmax....corona` and `max.vray` are both in the data. It also splits
// version numbers into digit runs, which match nothing and are dropped.
const SEPARATORS = /(?:[,;/+&|.\-–—>]+|\s+(?:and|with|using|plus|for|in|to|then)\s+)/

// The old free-text box cut answers off at 32 characters. Allow a little slack for a value that was
// trimmed of trailing whitespace after being cut.
const TRUNCATION_LENGTH = 30
// Below this a prefix is too ambiguous to be worth guessing at - `p` and `3d` say nothing.
const MIN_PREFIX = 4

const MATCH = [] // [{ alias, key }] - matched as a substring of the squashed segment
const TOKEN = new Map() // alias -> key - matched only as a whole word

for (const [key, def] of Object.entries(catalog.software)) {
  for (const alias of def.match || []) MATCH.push({ alias: squash(alias), key })
  for (const alias of def.token || []) TOKEN.set(squash(alias), key)
}

/**
 * Splits one raw answer into the individual products the author probably meant.
 *
 * Version numbers shed fragments here - splitting `vray3.4` on the dot leaves a stray `4` - so bare
 * numbers are dropped, as are single characters, which are only ever the tail of a truncation
 * (`3ds Max 2018, Corona Renderer, P`). Neither is a product, and left in they would dominate the
 * unrecognised list that exists to show which products are missing.
 */
const splitSegments = (raw) => {
  let s = String(raw).toLowerCase()
  for (const [re, to] of PROTECTED) s = s.replace(re, to)
  return s
    .split(SEPARATORS)
    .map((x) => x.trim().replace(/\s+/g, ' '))
    .filter((x) => x.length > 1 && !/^\d+$/.test(x))
}

/**
 * Every product named in one segment. Usually one, but `blender cycles` is legitimately two and
 * splitting on spaces would break `3ds max` far more often than it would help.
 */
const matchSegment = (segment) => {
  const flat = squash(segment)
  const hits = []

  if (flat) {
    for (const m of MATCH) {
      if (flat.includes(m.alias)) hits.push(m)
    }
  }
  for (const word of wordsOf(segment)) {
    for (const candidate of [word, deversion(word)]) {
      if (TOKEN.has(candidate)) {
        hits.push({ alias: candidate, key: TOKEN.get(candidate) })
        break
      }
    }
  }

  // A shorter alias sitting inside a longer one belonging to a different product is a coincidence,
  // not a second product: `quixel mixer` is Mixer, not Mixer plus Megascans, and `substance
  // designer` is Designer, not Designer plus Painter's bare `substance`.
  const kept = hits.filter(
    (h) => !hits.some((o) => o.key !== h.key && o.alias.length > h.alias.length && o.alias.includes(h.alias))
  )
  return new Set(kept.map((h) => h.key))
}

/** Products whose alias starts with this segment - the candidates for a truncated final segment. */
const prefixCandidates = (segment) => {
  const flat = squash(segment)
  if (flat.length < MIN_PREFIX) return []
  const keys = new Set()
  for (const m of MATCH) {
    if (m.alias.startsWith(flat) && m.alias !== flat) keys.add(m.key)
  }
  return [...keys]
}

/**
 * Pass one. Returns the products found outright, plus any segment that matched nothing - carrying
 * whether it is eligible to be treated as a truncation, for `resolve` to finish off.
 *
 * `value` is the raw field: a string on older submissions, an array on newer ones.
 */
const parse = (value) => {
  const entries = Array.isArray(value) ? value : [value]
  const found = new Set()
  const leftovers = []

  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim()) continue
    const segments = splitSegments(entry)
    // Only the final segment of a long answer can have been cut mid-word, and only a plain string
    // answer went through the box that did the cutting.
    const truncatable = entry.length >= TRUNCATION_LENGTH

    segments.forEach((segment, i) => {
      const keys = matchSegment(segment)
      if (keys.size) {
        for (const k of keys) found.add(k)
        return
      }
      leftovers.push({ segment, truncated: truncatable && i === segments.length - 1 })
    })
  }

  return { found, leftovers }
}

/**
 * Pass two. Given the strict counts from every `parse`, decides what a truncated segment was.
 * Returns the product key, or null to leave it unrecognised.
 */
const resolve = (leftover, counts) => {
  if (!leftover.truncated) return null
  const candidates = prefixCandidates(leftover.segment)
  if (!candidates.length) return null
  // Most-seen wins, so the corpus decides `subst` rather than the order of the catalog.
  return candidates.sort((a, b) => (counts[b] || 0) - (counts[a] || 0))[0]
}

module.exports = { catalog, parse, resolve, splitSegments, matchSegment }
