import escape from 'escape-html'
import type { FastifyInstance } from 'fastify'

import { taxonomyIndex, taxonomyOfType, typeNames } from '../utils/taxonomyViews.ts'

/**
 * The single-path category taxonomy: one tree per asset type, each node carrying a stable `id`
 * (uuid, survives renames), its canonical `path` (matching `asset.category` exactly), a URL-safe
 * `slugPath`, and a human description.
 *
 * Public and unauthenticated by design — the website, the Blender add-on and third parties all need
 * the same tree, and it contains no private data.
 */

export default async function (fastify: FastifyInstance) {
  // GET /taxonomy  ->  { types: {hdris: [...], textures: [...], models: [...]}, attributes: {...} }
  fastify.get('/', async (req, reply) => {
    return reply.code(200).send(taxonomyIndex())
  })

  // GET /taxonomy/:asset_type  ->  { type, categories: [...], attributes: {...} }
  fastify.get<{ Params: { asset_type: string } }>('/:asset_type', async (req, reply) => {
    const asset_type = req.params.asset_type

    const body = taxonomyOfType(asset_type)
    if (!body) {
      return reply.code(400).send({
        error: '400 Bad Request',
        message: `Unsupported asset type: ${escape(asset_type)}. Must be: ${typeNames.join('/')}`,
      })
    }

    return reply.code(200).send(body)
  })
}
