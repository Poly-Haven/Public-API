import escape from 'escape-html'
import type { FastifyInstance } from 'fastify'

import type { Asset } from '../types/firestore.ts'
import type { Query } from '../types/http.ts'

import { sendText } from '../utils/http.ts'
import cachedFirestore from '../utils/cachedFirestore.ts'
import type { CachedQuery } from '../utils/cachedFirestore.ts'
import { thumbnailUrl } from '../utils/imgUrl.ts'
import { applyFilters } from '../utils/assetFilters.ts'
import { publicVaultIds, maskVault } from '../utils/vaultStatus.ts'

import { assetTypes as asset_types } from '../utils/schemas.ts'

const db = cachedFirestore()

export default async function (fastify: FastifyInstance) {
  fastify.get<{ Querystring: Query }>('/', async (req, reply) => {
    const asset_type = req.query.type || req.query.t
    const categories = req.query.categories || req.query.c
    const includeUpcoming = req.query.future

    let collectionRef: CachedQuery<Asset> = db.collection<Asset>('assets')

    // Type
    if (String(asset_type) in asset_types) {
      const typeIndex = asset_types[String(asset_type)]
      if (typeIndex !== null) {
        collectionRef = collectionRef.where('type', '==', typeIndex)
      }
    } else if (asset_type) {
      return sendText(
        reply,
        400,
        `Unsupported asset type: ${escape(asset_type)}.
      Must be: ${Object.keys(asset_types).join('/')}`
      )
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
      const { old_id, reviewers, scale, staging, ...asset } = doc.data()
      if (staging) return
      if (!includeUpcoming && asset.date_published > now) return
      asset.thumbnail_url = thumbnailUrl(doc.id, asset)
      docs[doc.id] = maskVault(asset, publicVaults)
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
    const { unresolved, invalidAttribute } = applyFilters(docs, req.query, asset_type)
    if (unresolved) {
      return sendText(reply, 400, `Unknown category: ${escape(String(req.query.category || req.query.cat))}`)
    }
    if (invalidAttribute) {
      const { key, value, allowed, hint } = invalidAttribute
      const detail = hint ? ` (${escape(hint)})` : allowed ? `. Expected one of: ${allowed.join(', ')}` : ''
      return sendText(
        reply,
        400,
        `Unknown ${allowed || !hint ? 'value' : 'filter'} for ${escape(key)}: ${escape(value)}${detail}`
      )
    }

    return reply.code(200).send(docs)
  })
}
