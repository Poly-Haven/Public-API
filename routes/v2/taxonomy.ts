import type { FastifyInstance } from 'fastify'

import { taxonomyIndex, taxonomyOfType, typeNames } from '../../utils/taxonomyViews.ts'
import { publicCache, sendError, sendOk } from '../../utils/v2Cache.ts'

/** GET /v2/taxonomy and /v2/taxonomy/:type: the v1 bodies, wrapped in `data`. No early-access dimension. */
export default async function (fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => {
    publicCache(reply)
    return sendOk(reply, taxonomyIndex())
  })

  fastify.get<{ Params: { type: string } }>('/:type', async (req, reply) => {
    const type = req.params.type
    const body = typeNames.includes(type) ? taxonomyOfType(type) : null
    if (!body) return sendError(reply, 400, `Unsupported asset type. Must be: ${typeNames.join('/')}`)

    publicCache(reply)
    return sendOk(reply, body)
  })
}
