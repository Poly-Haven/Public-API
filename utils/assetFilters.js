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

/** Attribute keys this rework renamed away, with what replaced them. */
const RETIRED_KEYS = { indoor: 'environment', open_sky: 'sky_view', man_made: 'origin', outdoor: 'setting' }

// There is no reserved value for "empty" any more. An absent multi-value attribute means the asset
// was never assessed for it, exactly like an absent enum - "no wear or dirt" is the `clean` tag.

/**
 * Every spec declared for a key. One key can be declared by more than one type, so when the request
 * does not pin a type this returns all of them rather than whichever happens to come first - taking
 * the first match meant a value valid for models could be rejected using the textures vocabulary.
 */
const attributeSpecs = (assetType, key) => {
  if (assetType && assetType !== 'all' && attributeSchema.types[assetType]) {
    const spec = attributeSchema.types[assetType][key]
    return spec ? [spec] : []
  }
  return Object.values(attributeSchema.types)
    .map((spec) => spec[key])
    .filter(Boolean)
}

/**
 * Which branch a filter takes has to come from the schema rather than from the shape of the
 * requested value, otherwise `?condition=false` reads as a boolean test against a string[] and
 * quietly matches every asset.
 */
const attributeSpec = (assetType, key) => attributeSpecs(assetType, key)[0] || null

/** Values a filter will accept for a key, so a typo is a 400 rather than a silent empty page. */
const allowedValues = (assetType, key) => {
  const specs = attributeSpecs(assetType, key)
  if (!specs.length) return null
  const out = new Set()
  for (const spec of specs) {
    if (spec.type === 'boolean') {
      out.add('true').add('false')
      continue
    }
    if (!Array.isArray(spec.enum) || !spec.enum.length) return null // free-form, nothing to check
    for (const v of spec.enum) out.add(String(v).toLowerCase())
  }
  return out.size ? [...out] : null
}

/**
 * Pull recognised attribute filters out of a query object.
 * Returns { filters: { key: [values] }, invalid: [{ key, value, allowed, hint }] }.
 */
const parseAttributeFilters = (query, assetType) => {
  const allowed = new Set(attributeKeys(assetType))
  const filters = {}
  const invalid = []
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === '') continue

    if (!allowed.has(key)) {
      // An unrecognised KEY used to be dropped silently, which returned the whole asset type and
      // read as "no filter applied". That is exactly what a renamed key would now do, so the four
      // retired names and any key belonging to a different type are reported instead of ignored.
      if (RETIRED_KEYS[key]) {
        invalid.push({ key, value: String(value), allowed: null, hint: `renamed to '${RETIRED_KEYS[key]}'` })
      } else if (attributeSpecs(null, key).length) {
        invalid.push({ key, value: String(value), allowed: null, hint: `not an attribute of '${assetType}'` })
      }
      continue // anything else is an unrelated query param (t, future, sort, ...)
    }

    const values = String(value)
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
    if (!values.length) continue
    const permitted = allowedValues(assetType, key)
    if (permitted) {
      for (const v of values) if (!permitted.includes(v)) invalid.push({ key, value: v, allowed: permitted, hint: null })
    }
    filters[key] = values
  }
  return { filters, invalid }
}

const matchesAttributes = (asset, filters, assetType) => {
  const attrs = asset.attributes || {}
  for (const [key, wanted] of Object.entries(filters)) {
    const actual = attrs[key]
    const type = (attributeSpec(assetType, key) || {}).type

    if (type === 'boolean') {
      // A boolean is only ever stored when true, so absent means false. That is sound here because
      // every attribute whose false side is a thing in its own right is an enum instead.
      if (!wanted.includes(String(asBool(actual)))) return false
      continue
    }
    if (type === 'string[]') {
      // Tolerate a scalar as well as an array: models.condition was a single string until the
      // attribute rework, so this keeps working whichever order the deploy and the data migration
      // happen in. Costs nothing once every document has been migrated.
      const list = Array.isArray(actual) ? actual : actual === undefined || actual === null || actual === '' ? [] : [actual]
      // Absent means never assessed, so it matches nothing - the same rule the enum branch uses.
      // "No wear or dirt" is not absence, it is the `clean` tag.
      if (!list.length) return false
      if (!list.some((a) => wanted.includes(String(a).toLowerCase()))) return false
      continue
    }
    // enum and enum|null: absent means never assessed, which matches nothing.
    if (actual === undefined || actual === null) return false
    if (Array.isArray(actual)) {
      if (!actual.some((a) => wanted.includes(String(a).toLowerCase()))) return false
      continue
    }
    if (!wanted.includes(String(actual).toLowerCase())) return false
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
 * Returns { category } - the resolved canonical path, or null - plus `unresolved` for an unknown
 * category and `invalidAttribute` for an unknown attribute value, so callers can 400 on either.
 */
const applyFilters = (docs, query, assetType) => {
  const requestedCategory = query.category || query.cat
  const canonical = resolveCategory(assetType, requestedCategory)
  const { filters: attrFilters, invalid } = parseAttributeFilters(query, assetType)
  const collection = query.collection
  const vault = query.vault

  if (requestedCategory && !canonical) return { category: null, unresolved: true, invalidAttribute: null }
  // An unrecognised value used to fall through and return the full list, which reads as "no filter
  // applied" rather than "you asked for something that does not exist".
  if (invalid.length) return { category: canonical, unresolved: false, invalidAttribute: invalid[0] }

  if (!requestedCategory && !Object.keys(attrFilters).length && !collection && !vault) {
    return { category: canonical, unresolved: false, invalidAttribute: null }
  }

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
    if (!matchesAttributes(a, attrFilters, assetType)) delete docs[id]
  }
  return { category: canonical, unresolved: false, invalidAttribute: null }
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
  attributeSpec,
}
