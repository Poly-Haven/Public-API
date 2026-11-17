import type { Asset } from '../types/firestore.ts'
import cachedFirestore from './cachedFirestore.ts'
import type { CachedQuery } from './cachedFirestore.ts'
import { assetTypes as asset_types } from './schemas.ts'
import { isHiddenFromV1 } from './v1Freeze.ts'
import { maskVault, publicVaultIds } from './vaultStatus.ts'

const db = cachedFirestore()

export interface CategoryCountParams {
  /** The `:type` path segment. */
  assetType: string
  /** `?in=`: the comma-separated categories already chosen. */
  inCategories: string | undefined
  /** Whether early-access assets are counted. v1 takes `?future=`; v2 always does. */
  includeUpcoming: unknown
  /** Apply the v1 early-access freeze (utils/v1Freeze.ts). v2 never does. */
  v1Freeze?: boolean
}

/**
 * The category counts behind /categories/:type and /v2/categories/:type: how many assets sit in each category
 * (or, for type `all`, in each asset type), most common first. Null when the type is not one of asset_types.
 */
export const countCategories = async ({
  assetType: asset_type,
  inCategories: categories,
  includeUpcoming,
  v1Freeze = false,
}: CategoryCountParams): Promise<Record<string, number> | null> => {
  let collectionRef: CachedQuery<Asset> = db.collection<Asset>('assets')

  // Type
  if (asset_type in asset_types) {
    const typeIndex = asset_types[asset_type]
    if (typeIndex !== null) {
      collectionRef = collectionRef.where('type', '==', typeIndex)
    }
  } else if (asset_type) {
    return null
  }

  // Categories: the ones already chosen, which an asset must all carry. Filtered in memory on the vault-masked
  // asset rather than by an `array-contains` clause on the stored one (see utils/assetList.ts), so a legacy
  // `vault: <id>` category cannot confirm an unannounced vault, and the counts never include it.
  const original_categories_arr = categories ? categories.split(',').map((c) => c.trim()) : []

  // Get data and convert to an object we can work with further
  const collection = await collectionRef.get()
  const publicVaults = await publicVaultIds()
  const now = Math.floor(Date.now() / 1000)
  const docs: Record<string, Asset> = {}
  collection.forEach((doc) => {
    // maskVault copies when it changes anything, so the cached doc is never touched.
    const asset = maskVault(doc.data(), publicVaults)
    // Filter unpublished
    if (asset.staging) return
    if (!includeUpcoming && asset.date_published > now) return
    if (v1Freeze && isHiddenFromV1(doc.id, asset, now)) return
    // Filter out the assets that aren't in all specifed categories
    if (!original_categories_arr.every((cat) => Array.isArray(asset.categories) && asset.categories.includes(cat)))
      return
    docs[doc.id] = asset
  })

  // Combine and count occurances
  const all_categories: Record<string, number> = {}
  if (asset_type !== 'all') {
    for (const id in docs) {
      for (const cat of docs[id].categories) {
        all_categories[cat] = (all_categories[cat] || 0) + 1
      }
      if (!categories) {
        all_categories.all = (all_categories.all || 0) + 1
      }
    }
  } else {
    for (const id in docs) {
      const type_name = Object.keys(asset_types)[docs[id].type]
      all_categories[type_name] = (all_categories[type_name] || 0) + 1
      if (!categories) {
        all_categories.all = (all_categories.all || 0) + 1
      }
    }
  }

  for (const cat of original_categories_arr) {
    // We don't need to show the parent counts
    delete all_categories[cat]
  }

  return Object.entries(all_categories)
    .sort(([, v1], [, v2]) => v2 - v1)
    .reduce<Record<string, number>>((r, [k, v]) => ({ ...r, [k]: v }), {})
}
