import escape from 'escape-html'
import type { FastifyInstance } from 'fastify'

import type { Query } from '../types/http.ts'
import { countCategories } from '../utils/categoryCounts.ts'
import { sendText } from '../utils/http.ts'
import { assetTypes as asset_types } from '../utils/schemas.ts'

export default async function (fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => {
    return sendText(reply, 400, `Please format your request as /categories/[type]`)
  })

  fastify.get<{ Params: { asset_type: string }; Querystring: Query }>('/:asset_type', async (req, reply) => {
    const asset_type = req.params.asset_type

    const counts = await countCategories({
      assetType: asset_type,
      inCategories: req.query.in,
      includeUpcoming: req.query.future,
      v1Freeze: true,
    })
    if (!counts) {
      return sendText(
        reply,
        400,
        `Unsupported asset type: ${escape(asset_type)}.
      Must be: ${Object.keys(asset_types).join('/')}`
      )
    }

    return reply.code(200).send(counts)
  })
}
