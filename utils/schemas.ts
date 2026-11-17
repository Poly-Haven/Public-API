// The JSON files shared with admin.polyhaven.com (taxonomy.json and attributes.json are generated from its
// registry, do not edit them here), given the types the code reads them as. Importing the JSON directly
// would infer a huge literal type; typing it once here keeps every consumer on the same narrow shape.
import assetTypesJson from '../asset_types.json' with { type: 'json' }
import attributesJson from '../attributes.json' with { type: 'json' }
import patreonTiersJson from '../constants/patreon_tiers.json' with { type: 'json' }
import taxonomyJson from '../taxonomy.json' with { type: 'json' }
import type { PatreonTiers } from '../types/firestore.ts'

export interface TaxonomyNode {
  name: string
  slug: string
  /** Canonical path, matching `asset.category` exactly. */
  path: string
  /** URL-safe path, e.g. "coast-water/beaches". */
  slugPath: string
  id: string
  description: string
  children: TaxonomyNode[]
}

export interface AttributeSpec {
  /** 'boolean' | 'string[]' | 'enum' | 'enum|null' */
  type: string
  enum?: unknown[]
  description?: string
}

/** Asset type name -> index into the stored `type` field; `all` is null (no type filter). */
export const assetTypes: Record<string, number | null> = assetTypesJson
export const taxonomy: { types: Record<string, TaxonomyNode[]> } = taxonomyJson
export const attributeSchema: { types: Record<string, Record<string, AttributeSpec>> } = attributesJson
export const patreonTiers: PatreonTiers = patreonTiersJson
