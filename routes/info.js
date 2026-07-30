const escape = require('escape-html')
const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const db = firestore()

router.get('/', (req, res) => {
  res.status(400).send(`Please format your request as /info/[asset_id]`)
})

router.get('/:id', async (req, res) => {
  const asset_id = req.params.id

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
    const data = doc.data()
    // Add thumbnail URL
    data.thumbnail_url = `https://cdn.polyhaven.com/asset_img/thumbs/${asset_id}.png?width=256&height=256`
    // Asset data only changes on publish, and publishing purges the CDN. Set only on success so a
    // 404 for an asset that is about to exist does not get pinned at the edge.
    res.set('Cache-Control', 'public, max-age=43200, s-maxage=43200, stale-while-revalidate=86400')
    res.status(200).json(data)
  }
})

module.exports = router
