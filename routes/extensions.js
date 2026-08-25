const express = require('express')
const router = express.Router()

const extensions = require('../extensions.json')

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

// GET /extensions  ->  { version, blocklist, data: [...] }
router.get('/', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600')
  res.status(200).json(extensions)
})

module.exports = router
