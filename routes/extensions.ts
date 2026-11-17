import type { FastifyInstance } from 'fastify'

import extensions from '../extensions.json' with { type: 'json' }

/**
 * Poly Haven's public Blender extensions repository.
 *
 * Users add this URL under Preferences > Get Extensions > Repositories. Today it advertises a
 * single `asset-library` extension whose archive points Blender at our remote asset library
 * (/bl_repo/). The listing entry deliberately carries no `remote_url` — Blender's own
 * `server-generate` strips the `[asset_library]` table from listings, because that table is
 * only read after the archive itself is downloaded.
 *
 * Public and unauthenticated. `assetlib_auth_method` is omitted, which Blender reads as the
 * default `PER_LIBRARY`; our library needs no token.
 *
 * Safe to serve before Blender 5.3 ships: clients skip listing entries whose `type` they don't
 * recognise, so an older Blender sees an empty repository rather than an error.
 *
 * Note this is unrelated to /v2/extensions, which serves the paid add-on.
 */

export default async function (fastify: FastifyInstance) {
  // GET /extensions  ->  { version, blocklist, data: [...] }
  fastify.get('/', async (req, reply) => {
    reply.header('Cache-Control', 'public, max-age=3600')
    return reply.code(200).send(extensions)
  })
}
