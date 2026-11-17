import type { FastifyInstance } from 'fastify'

import type { Query } from '../../types/http.ts'
import { countCategories } from '../../utils/categoryCounts.ts'
import { assetTypes as asset_types } from '../../utils/schemas.ts'
import { publicCache, sendError, sendOk, sendUnavailable } from '../../utils/v2Cache.ts'
import { hasPlainQuery } from '../../utils/v2Query.ts'

/** GET /v2/categories/:type: /categories/:type as v1 answers it with ?future=true, early-access assets counted. */
export default async function (fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => sendError(reply, 400, 'Please format your request as /v2/categories/[type]'))

  fastify.get<{ Params: { type: string }; Querystring: Query }>('/:type', async (req, reply) => {
    if (!hasPlainQuery(req)) return sendError(reply, 400, 'Query parameters must be plain values')
    const type = req.params.type
    if (!Object.hasOwn(asset_types, type)) {
      return sendError(reply, 400, `Unsupported asset type. Must be: ${Object.keys(asset_types).join('/')}`)
    }

    let counts
    try {
      counts = await countCategories({ assetType: type, inCategories: req.query.in, includeUpcoming: true })
    } catch (err) {
      return sendUnavailable(reply, 'V2 CATEGORIES', err)
    }

    publicCache(reply)
    return sendOk(reply, counts)
  })
}
