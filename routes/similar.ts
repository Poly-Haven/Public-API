import escape from 'escape-html'
import type { FastifyInstance } from 'fastify'

import type { Query } from '../types/http.ts'
import { sendText } from '../utils/http.ts'
import { findSimilar, parseNum } from '../utils/similarAssets.ts'

export default async function (fastify: FastifyInstance) {
  fastify.get('/', (req, reply) => {
    return sendText(reply, 400, `Please format your request as /similar/[asset_id]`)
  })

  fastify.get<{ Params: { id: string }; Querystring: Query }>('/:id', async (req, reply) => {
    const asset_id = req.params.id

    if (!asset_id) {
      return sendText(reply, 400, `No asset with that ID`)
    }

    const MAX_ID_LENGTH = 50
    if (asset_id.length > MAX_ID_LENGTH) {
      return sendText(reply, 400, `No asset with that ID`)
    }

    const validPattern = /^[a-zA-Z0-9_-]+$/
    if (!validPattern.test(asset_id)) {
      return sendText(reply, 400, `No asset with that ID`)
    }

    const similar = await findSimilar({
      assetId: asset_id,
      num: parseNum(req.query.num),
      vectorOnly: req.query.lane === 'vector',
      includeUpcoming: false,
    })

    if (!similar) {
      // This route reads the shared 10-minute collection cache and has no per-document
      // fallback, so a just-created asset is genuinely absent here for a while - and unlike a
      // permanent 404 that one must not be cached. Whether the edge honours this depends on the
      // zone's cache rules, which currently rewrite Cache-Control; the publish purge covers
      // /similar/<slug> either way.
      reply.header('Cache-Control', 'no-store')
      return sendText(reply, 404, `No asset with id ${escape(asset_id)}`)
    }

    return reply.code(200).send(similar)
  })
}
