import type { FastifyInstance } from 'fastify'

import type { Query } from '../../types/http.ts'
import { findSimilar, parseNum } from '../../utils/similarAssets.ts'
import { checkAssetId } from '../../utils/v2Assets.ts'
import { publicCache, sendError, sendOk, sendUnavailable } from '../../utils/v2Cache.ts'
import { hasPlainQuery } from '../../utils/v2Query.ts'

/**
 * GET /v2/similar/:id: /similar/:id as v1 answers it, except that early-access assets may appear in the results
 * (their metadata is public), shaped like the items of /v2/assets. Staging assets never do, and a staging id is a 404.
 */
export default async function (fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => sendError(reply, 400, 'Please format your request as /v2/similar/[asset_id]'))

  fastify.get<{ Params: { id: string }; Querystring: Query }>('/:id', async (req, reply) => {
    const id = req.params.id
    const bad = checkAssetId(reply, id)
    if (bad) return bad
    if (!hasPlainQuery(req)) return sendError(reply, 400, 'Query parameters must be plain values')

    let similar
    try {
      similar = await findSimilar({
        assetId: id,
        num: parseNum(req.query.num),
        vectorOnly: req.query.lane === 'vector',
        includeUpcoming: true,
        refuseStaging: true,
        publicItems: true,
      })
    } catch (err) {
      return sendUnavailable(reply, 'V2 SIMILAR', err)
    }
    if (!similar) return sendError(reply, 404, `No asset with id ${id}`)

    publicCache(reply)
    return sendOk(reply, similar)
  })
}
