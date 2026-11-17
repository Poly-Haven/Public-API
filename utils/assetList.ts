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

  // Categories (1/2)
  let categories_arr: string[] = []
  if (categories) {
    // Firestore only supports using one 'array-contains' check. So we filter for the last one, and then will manually filter the rest later.
    categories_arr = categories.split(',').map((c) => c.trim())
    const last_cat = categories_arr.pop()
    collectionRef = collectionRef.where('categories', 'array-contains', last_cat)
  }

  // Get data and convert to an object we can work with further.
  // doc.data() returns the live cached object, so copy each one before touching it, dropping the
  // fields we do not serve and adding the thumbnail in the same pass. Editing them in place used to
  // strip old_id, reviewers and scale out of the shared cache for every other route.
  const collection = await collectionRef.get()
  const now = Math.floor(Date.now() / 1000)
  // Assets in a vault that hasn't been announced are listed like any other early-access asset, but
  // attributed only to "an upcoming vault". Masked here, before applyFilters, so ?vault=<id> can't
  // be used to confirm a guessed vault name.
  const publicVaults = await publicVaultIds()
  const docs: Record<string, Asset> = {}
  collection.forEach((doc) => {
    const raw = doc.data()
    if (raw.staging) return
    if (!includeUpcoming && raw.date_published > now) return
    if (v1Freeze && isHiddenFromV1(doc.id, raw, now)) return
    docs[doc.id] = publicAsset(doc.id, raw, publicVaults) as Asset
  })

  // Categories (2/2)
  // Filter out the remaining assets that aren't in all specifed categories
  for (const cat of categories_arr) {
    for (const id in docs) {
      if (!docs[id].categories.includes(cat)) {
        delete docs[id]
      }
    }
  }

  // New single-path category system: ?category= (inclusive of descendants, canonical or slug path),
  // ?collection=, ?vault=, and any attribute key for this type (e.g. ?weather=clear&indoor=true).
  const { unresolved, invalidAttribute } = applyFilters(docs, query, asset_type)
  if (unresolved) return { ok: false, error: { kind: 'category' } }
  if (invalidAttribute) return { ok: false, error: { kind: 'attribute', invalid: invalidAttribute } }

  return { ok: true, docs }
}
