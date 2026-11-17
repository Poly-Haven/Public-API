import type { Asset } from '../types/firestore.ts'
import type { InvalidAttribute, Query } from '../types/http.ts'
import { applyFilters } from './assetFilters.ts'
import cachedFirestore from './cachedFirestore.ts'
import type { CachedQuery } from './cachedFirestore.ts'
import { thumbnailUrl } from './imgUrl.ts'
import { assetTypes as asset_types } from './schemas.ts'
import { isHiddenFromV1 } from './v1Freeze.ts'
import { publicVaultIds, maskVault } from './vaultStatus.ts'

const db = cachedFirestore()

/**
 * An asset as the public may see it: a copy without the internal fields (old_id, reviewers, scale, staging),
 * with its thumbnail URL, and with an unannounced vault masked. Null for a staging asset, which is never
 * public. Never mutates `raw`, which is the live cached object shared with every other route.
 */
export const publicAsset = (id: string, raw: Asset, publicVaults: Set<string>): Asset | null => {
  const { old_id, reviewers, scale, staging, ...asset } = raw
  if (staging) return null
  asset.thumbnail_url = thumbnailUrl(id, asset)
  return maskVault(asset, publicVaults)
}

export interface AssetListParams {
  /** `?type=` / `?t=`. */
  assetType: string | undefined
  /** `?categories=` / `?c=`: the legacy comma-separated list. */
  categories: string | undefined
  /** Whether early-access assets are listed. v1 takes `?future=`; v2 always does. */
  includeUpcoming: unknown
  /** The whole querystring, for applyFilters (category, collection, vault and attribute filters). */
  query: Query
  /** Apply the v1 early-access freeze (utils/v1Freeze.ts). v2 never does. */
  v1Freeze?: boolean
}

export type AssetListResult =
  | { ok: true; docs: Record<string, Asset> }
  | { ok: false; error: { kind: 'type' } | { kind: 'category' } | { kind: 'attribute'; invalid: InvalidAttribute } }

/**
 * The listing behind /assets and /v2/assets: the same filtering, masking and thumbnails, with only the
 * early-access switch (and, for v1, the freeze) differing. A failed filter comes back as `error` for the route
 * to word in its own format.
 */
export const listAssets = async ({
  assetType: asset_type,
  categories,
  includeUpcoming,
  query,
  v1Freeze = false,
}: AssetListParams): Promise<AssetListResult> => {
  let collectionRef: CachedQuery<Asset> = db.collection<Asset>('assets')

  // Type
  if (String(asset_type) in asset_types) {
    const typeIndex = asset_types[String(asset_type)]
    if (typeIndex !== null) {
      collectionRef = collectionRef.where('type', '==', typeIndex)
    }
  } else if (asset_type) {
    return { ok: false, error: { kind: 'type' } }
  }

  // Categories. The legacy comma-separated list, every one of which an asset must carry. Not handed to the
  // collection as an `array-contains` clause: that would test the stored categories, and the unannounced-vault
  // masking below has to happen first, or `?c=vault: <id>` could confirm which vault an asset is in. Filtered
  // in memory on the masked copy instead (the cache does the same either way).
  const categories_arr = categories ? categories.split(',').map((c) => c.trim()) : []

  // Get data and convert to an object we can work with further.
  // doc.data() returns the live cached object, so copy each one before touching it, dropping the
  // fields we do not serve and adding the thumbnail in the same pass. Editing them in place used to
  // strip old_id, reviewers and scale out of the shared cache for every other route.
  const collection = await collectionRef.get()
  const now = Math.floor(Date.now() / 1000)
  // Assets in a vault that hasn't been announced are listed like any other early-access asset, but
  // attributed only to "an upcoming vault". Masked here, before the category filter and applyFilters, so
  // neither ?categories= nor ?vault=<id> can be used to confirm a guessed vault name.
  const publicVaults = await publicVaultIds()
  const docs: Record<string, Asset> = {}
  collection.forEach((doc) => {
    const raw = doc.data()
    if (raw.staging) return
    if (!includeUpcoming && raw.date_published > now) return
    if (v1Freeze && isHiddenFromV1(doc.id, raw, now)) return
    const asset = publicAsset(doc.id, raw, publicVaults) as Asset
    // Assets that aren't in all the specified categories (as the public sees them).
    if (categories_arr.every((cat) => Array.isArray(asset.categories) && asset.categories.includes(cat))) {
      docs[doc.id] = asset
    }
  })

  // New single-path category system: ?category= (inclusive of descendants, canonical or slug path),
  // ?collection=, ?vault=, and any attribute key for this type (e.g. ?weather=clear&indoor=true).
  const { unresolved, invalidAttribute } = applyFilters(docs, query, asset_type)
  if (unresolved) return { ok: false, error: { kind: 'category' } }
  if (invalidAttribute) return { ok: false, error: { kind: 'attribute', invalid: invalidAttribute } }

  return { ok: true, docs }
}
