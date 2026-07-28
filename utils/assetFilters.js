const taxonomy = require('../taxonomy.json')
const attributeSchema = require('../attributes.json')

/**
 * Filtering for the single-path category system, shared by /assets and /v2/assets.
 *
 * - `category` is INCLUSIVE: asking for "Coast & Water" also returns everything nested beneath it,
 *   matching Blender's catalog semantics and the website's browse behaviour.
 * - Accepts either the canonical path ("Coast & Water/Beaches") or the URL slug path
 *   ("coast-water/beaches"), so clients can use whichever they already hold.
 * - Attribute filters are an allowlist per type (see attributes.json). Multiple comma-separated
 *   values are OR'd; different attributes are AND'd. Array-valued attributes (material, condition)
 *   match if the asset's array contains any requested value.
 */

// slugPath -> canonical path, per type (built once at require time)
const slugIndex = {}
const canonicalIndex = {}
for (const [type, roots] of Object.entries(taxonomy.types)) {
  const slugs = {}
  const canon = new Set()
  const walk = (nodes) => {
    for (const n of nodes) {
      slugs[n.slugPath] = n.path
      canon.add(n.path)
      walk(n.children)
    }
  }
  walk(roots)
  slugIndex[type] = slugs
  canonicalIndex[type] = canon
}

/** Resolve a caller-supplied category to its canonical path, or null if it isn't a real category. */
const resolveCategory = (assetType, value) => {
  if (!value) return null
  const raw = String(value).trim().replace(/^\/+|\/+$/g, '')
  if (!raw) return null
  const types = assetType && assetType !== 'all' ? [assetType] : Object.keys(taxonomy.types)
  for (const t of types) {
    if (canonicalIndex[t] && canonicalIndex[t].has(raw)) return raw
    const bySlug = slugIndex[t] && slugIndex[t][raw.toLowerCase()]
    if (bySlug) return bySlug
  }
  return null
}

/** Inclusive path match: the node itself plus every descendant. */
const matchesCategory = (assetCategory, canonicalPath) =>
  typeof assetCategory === 'string' &&
  (assetCategory === canonicalPath || assetCategory.startsWith(canonicalPath + '/'))

/** Every attribute key known for a type (or all types when unspecified). */
const attributeKeys = (assetType) => {
  if (assetType && assetType !== 'all' && attributeSchema.types[assetType]) {
    return Object.keys(attributeSchema.types[assetType])
  }
  const keys = new Set()
  for (const spec of Object.values(attributeSchema.types)) Object.keys(spec).forEach((k) => keys.add(k))
  return [...keys]
}

const asBool = (v) => v === true || v === 'true' || v === '1' || v === 1

/** Pull recognised attribute filters out of a query object. Returns { key: [values] }. */
const parseAttributeFilters = (query, assetType) => {
  const allowed = new Set(attributeKeys(assetType))
  const filters = {}
  for (const [key, value] of Object.entries(query || {})) {
    if (!allowed.has(key) || value === undefined || value === '') continue
    const values = String(value)
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
    if (values.length) filters[key] = values
  }
  return filters
}

const matchesAttributes = (asset, filters) => {
  const attrs = asset.attributes || {}
  for (const [key, wanted] of Object.entries(filters)) {
    const actual = attrs[key]
    // Booleans are stored only when true, so an absent value means false.
    if (wanted.every((w) => w === 'true' || w === 'false')) {
      const isTrue = asBool(actual)
      if (!wanted.includes(String(isTrue))) return false
      continue
    }
    if (Array.isArray(actual)) {
      if (!actual.some((a) => wanted.includes(String(a).toLowerCase()))) return false
    } else {
      if (actual === undefined || actual === null) return false
      if (!wanted.includes(String(actual).toLowerCase())) return false
    }
  }
  return true
}

const matchesCollection = (asset, id) =>
  (Array.isArray(asset.collections) && asset.collections.includes(id)) ||
  // Fall back to the legacy category string so nothing is missed mid-transition.
  (Array.isArray(asset.categories) && asset.categories.includes(`collection: ${id}`))

const matchesVault = (asset, id) =>
  asset.vault === id || (Array.isArray(asset.categories) && asset.categories.includes(`vault: ${id}`))

/**
 * Apply every new-system filter to a { id: asset } map, deleting non-matches in place.
 * Returns { category } — the resolved canonical path, or null — so callers can 400 on a bad value.
 */
const applyFilters = (docs, query, assetType) => {
  const requestedCategory = query.category || query.cat
  const canonical = resolveCategory(assetType, requestedCategory)
  const attrFilters = parseAttributeFilters(query, assetType)
  const collection = query.collection
  const vault = query.vault

  if (!requestedCategory && !Object.keys(attrFilters).length && !collection && !vault) {
    return { category: canonical, unresolved: false }
  }
  if (requestedCategory && !canonical) return { category: null, unresolved: true }

  for (const id in docs) {
    const a = docs[id]
    if (canonical && !matchesCategory(a.category, canonical)) {
      delete docs[id]
      continue
    }
    if (collection && !matchesCollection(a, collection)) {
      delete docs[id]
      continue
    }
    if (vault && !matchesVault(a, vault)) {
      delete docs[id]
      continue
    }
    if (!matchesAttributes(a, attrFilters)) delete docs[id]
  }
  return { category: canonical, unresolved: false }
}

module.exports = {
  applyFilters,
  resolveCategory,
  matchesCategory,
  matchesCollection,
  matchesVault,
  parseAttributeFilters,
  matchesAttributes,
  attributeKeys,
}
