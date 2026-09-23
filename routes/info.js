const escape = require('escape-html')
const express = require('express')
const router = express.Router()

const firestore = require('../firestore')
const { thumbnailUrl } = require('../utils/imgUrl')
const { publicVaultIds, maskVault } = require('../utils/vaultStatus')

const db = firestore()

router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.status(400).send(`Please format your request as /info/[asset_id]`)
})

router.get('/:id', async (req, res) => {
  const asset_id = req.params.id

  // Uncacheable by default; the success branch below opts back in. The error branches used to
  // just omit Cache-Control and rely on the edge leaving them alone, but this zone overrides
  // origin cache headers - so a 404 for an asset that is about to exist could be pinned at the
  // edge for hours, long enough to outlive the publish that created the asset.
  res.set('Cache-Control', 'no-store')

  if (!asset_id) {
    res.status(400).send(`No asset with that ID`)
    return
  }

  const MAX_ID_LENGTH = 50
  if (asset_id.length > MAX_ID_LENGTH) {
    res.status(400).send(`No asset with that ID`)
    return
  }

  const validPattern = /^[a-zA-Z0-9_-]+$/
  if (!validPattern.test(asset_id)) {
    res.status(400).send(`No asset with that ID`)
    return
  }

  const doc = await db.collection('assets').doc(asset_id).get()
  if (!doc.exists) {
    res.status(404).send(`No asset with id ${escape(asset_id)}`)
  } else {
    // reviewers is internal review metadata and has no business in a public response. /assets and
    // /v2/assets have always stripped it, this endpoint just never did. Destructured rather than
    // deleted so the doc is never mutated, in case this route ever moves onto the shared cache.
    const { reviewers, ...unmasked } = doc.data()
    // An asset in a vault that hasn't been announced is attributed to "an upcoming vault" only -
    // this is the response its asset page is built from.
    const data = maskVault(unmasked, await publicVaultIds())
    // Add thumbnail URL
    data.thumbnail_url = thumbnailUrl(asset_id, data)
    // Asset data only changes on publish, and publishing purges the CDN. Overrides the
    // no-store set at the top of the handler.
    res.set('Cache-Control', 'public, max-age=43200, s-maxage=43200, stale-while-revalidate=86400')
    res.status(200).json(data)
  }
})

module.exports = router
