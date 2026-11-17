import type { FastifyInstance } from 'fastify'

import type { Query } from '../../types/http.ts'
import { listAssets } from '../../utils/assetList.ts'
import { assetTypes as asset_types } from '../../utils/schemas.ts'
import { publicCache, sendError, sendOk, sendUnavailable } from '../../utils/v2Cache.ts'
import { hasPlainQuery, isAssetType } from '../../utils/v2Query.ts'

/**
 * GET /v2/assets: every non-staging asset's metadata, early-access ones included. Keyless, and the same bytes
 * for everyone (an Authorization header is ignored), so the edge can cache it. Only the files of an
 * early-access asset are behind a key.
 *
 * Filters as /assets: ?type=/?t=, ?categories=/?c=, ?category=, ?collection=, ?vault= and per-type attributes.
 */
export default async function (fastify: FastifyInstance) {
  fastify.get<{ Querystring: Query }>('/', async (req, reply) => {
    if (!hasPlainQuery(req)) return sendError(reply, 400, 'Query parameters must be plain values')
    const asset_type = req.query.type || req.query.t
    const categories = req.query.categories || req.query.c
    if (!isAssetType(asset_type)) {
      return sendError(reply, 400, `Unsupported asset type. Must be: ${Object.keys(asset_types).join('/')}`)
    }

    let result
    try {
      result = await listAssets({ assetType: asset_type, categories, includeUpcoming: true, query: req.query })
    } catch (err) {
      return sendUnavailable(reply, 'V2 ASSETS', err)
    }

    if (!result.ok) {
      const { error } = result
      if (error.kind === 'type') {
        return sendError(reply, 400, `Unsupported asset type. Must be: ${Object.keys(asset_types).join('/')}`)
      }
      if (error.kind === 'category') {
        return sendError(reply, 400, `Unknown category: ${req.query.category || req.query.cat}`)
      }
      const { key, value, allowed, hint } = error.invalid
      return sendError(reply, 400, hint ? `Unknown filter '${key}' (${hint})` : `Unknown value for ${key}: ${value}`, {
        extra: { allowed },
      })
    }

    publicCache(reply)
    return sendOk(reply, result.docs)
  })
}
