import type { Asset } from '../types/firestore.ts'
import cachedFirestore from './cachedFirestore.ts'
import type { CachedQuery } from './cachedFirestore.ts'
import { assetTypes as asset_types } from './schemas.ts'
import { isHiddenFromV1 } from './v1Freeze.ts'

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

  // Categories (1/2)
  let original_categories_arr: string[] = []
  let categories_arr: string[] = []
  if (categories) {
    // Firestore only supports using one 'array-contains' check. So we filter for the last one, and then will manually filter the rest later.
    // TODO Reduce Firestore reads by first getting assets according to least-used category. Will need to separately track which categories are least used, maybe with cloud function.
    original_categories_arr = categories.split(',').map((c) => c.trim())
    categories_arr = Array.from(original_categories_arr) // Deep copy to keep original intact.
    const last_cat = categories_arr.pop()
    collectionRef = collectionRef.where('categories', 'array-contains', last_cat)
  }

  // Get data and convert to an object we can work with further
  const collection = await collectionRef.get()
  let docs: Record<string, Asset> = {}
  collection.forEach((doc) => {
    docs[doc.id] = doc.data()
  })

  // Filter unpublished
  const now = Math.floor(Date.now() / 1000)
  for (const id in docs) {
    if (docs[id].staging) {
      delete docs[id]
    } else if (!includeUpcoming && docs[id].date_published > now) {
      delete docs[id]
    } else if (v1Freeze && isHiddenFromV1(id, docs[id], now)) {
      delete docs[id]
    }
  }

  // Categories (2/2)
  // Filter out the remaining assets that aren't in all specifed categories
  for (const cat of categories_arr) {
    for (const id in docs) {
      if (!docs[id].categories.includes(cat)) {
        delete docs[id]
      }
    }
  }

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
