const escape = require('escape-html')
const express = require('express')
const router = express.Router()

const taxonomy = require('../taxonomy.json')
const attributes = require('../attributes.json')

const asset_types = require('../asset_types.json')

/**
 * The single-path category taxonomy: one tree per asset type, each node carrying a stable `id`
 * (uuid, survives renames), its canonical `path` (matching `asset.category` exactly), a URL-safe
 * `slugPath`, and a human description.
 *
 * Public and unauthenticated by design — the website, the Blender add-on and third parties all need
 * the same tree, and it contains no private data.
 */

const typeNames = Object.keys(asset_types).filter((t) => t !== 'all')

// GET /taxonomy  ->  { types: {hdris: [...], textures: [...], models: [...]}, attributes: {...} }
router.get('/', (req, res) => {
  res.status(200).json({
    types: taxonomy.types,
    attributes: attributes.types,
  })
})

// GET /taxonomy/:asset_type  ->  { type, categories: [...], attributes: {...} }
router.get('/:asset_type', (req, res) => {
  const asset_type = req.params.asset_type

  if (!(asset_type in asset_types) || asset_type === 'all') {
    res.status(400).json({
      error: '400 Bad Request',
      message: `Unsupported asset type: ${escape(asset_type)}. Must be: ${typeNames.join('/')}`,
    })
    return
  }

  res.status(200).json({
    type: asset_type,
    categories: taxonomy.types[asset_type],
    attributes: attributes.types[asset_type],
  })
})

module.exports = router
