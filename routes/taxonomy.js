import escape from 'escape-html'

import taxonomy from '../taxonomy.json' with { type: 'json' }
import attributes from '../attributes.json' with { type: 'json' }

import asset_types from '../asset_types.json' with { type: 'json' }

/**
 * The single-path category taxonomy: one tree per asset type, each node carrying a stable `id`
 * (uuid, survives renames), its canonical `path` (matching `asset.category` exactly), a URL-safe
 * `slugPath`, and a human description.
 *
 * Public and unauthenticated by design — the website, the Blender add-on and third parties all need
 * the same tree, and it contains no private data.
 */

const typeNames = Object.keys(asset_types).filter((t) => t !== 'all')

export default async function (fastify) {
  // GET /taxonomy  ->  { types: {hdris: [...], textures: [...], models: [...]}, attributes: {...} }
  fastify.get('/', async (req, reply) => {
    return reply.code(200).send({
      types: taxonomy.types,
      attributes: attributes.types,
    })
  })

  // GET /taxonomy/:asset_type  ->  { type, categories: [...], attributes: {...} }
  fastify.get('/:asset_type', async (req, reply) => {
    const asset_type = req.params.asset_type

    if (!(asset_type in asset_types) || asset_type === 'all') {
      return reply.code(400).send({
        error: '400 Bad Request',
        message: `Unsupported asset type: ${escape(asset_type)}. Must be: ${typeNames.join('/')}`,
      })
    }

    return reply.code(200).send({
      type: asset_type,
      categories: taxonomy.types[asset_type],
      attributes: attributes.types[asset_type],
    })
  })
}
