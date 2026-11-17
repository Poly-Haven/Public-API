import escape from 'escape-html'
import type { FastifyInstance } from 'fastify'

import type { Query } from '../types/http.ts'

import { sendText } from '../utils/http.ts'
import { listAssets } from '../utils/assetList.ts'

import { assetTypes as asset_types } from '../utils/schemas.ts'

export default async function (fastify: FastifyInstance) {
  fastify.get<{ Querystring: Query }>('/', async (req, reply) => {
    const asset_type = req.query.type || req.query.t
    const categories = req.query.categories || req.query.c
    const includeUpcoming = req.query.future

    const result = await listAssets({
      assetType: asset_type,
      categories,
      includeUpcoming,
      query: req.query,
      v1Freeze: true,
    })
    if (!result.ok) {
      const { error } = result
      if (error.kind === 'type') {
        return sendText(
          reply,
          400,
          `Unsupported asset type: ${escape(asset_type as string)}.
      Must be: ${Object.keys(asset_types).join('/')}`
        )
      }
      if (error.kind === 'category') {
        return sendText(reply, 400, `Unknown category: ${escape(String(req.query.category || req.query.cat))}`)
      }
      const { key, value, allowed, hint } = error.invalid
      const detail = hint ? ` (${escape(hint)})` : allowed ? `. Expected one of: ${allowed.join(', ')}` : ''
      return sendText(
        reply,
        400,
        `Unknown ${allowed || !hint ? 'value' : 'filter'} for ${escape(key)}: ${escape(value)}${detail}`
      )
    }

    return reply.code(200).send(result.docs)
  })
}
