const escape = require('escape-html')
const express = require('express')
const router = express.Router()

const cachedFirestore = require('../utils/cachedFirestore')
const { applyFilters } = require('../utils/assetFilters')

const asset_types = require('../asset_types.json')

const db = cachedFirestore()

router.get('/', async (req, res) => {
  const asset_type = req.query.type || req.query.t
  const categories = req.query.categories || req.query.c
  const includeUpcoming = req.query.future

  let collectionRef = db.collection('assets')

  // Type
  if (asset_type in asset_types) {
    const typeIndex = asset_types[asset_type]
    if (typeIndex !== null) {
      collectionRef = collectionRef.where('type', '==', typeIndex)
    }
  } else if (asset_type) {
    res.status(400).send(
      `Unsupported asset type: ${escape(asset_type)}.
      Must be: ${Object.keys(asset_types).join('/')}`
    )
    return
  }

  // Categories (1/2)
  let categories_arr = []
  if (categories) {
    // Firestore only supports using one 'array-contains' check. So we filter for the last one, and then will manually filter the rest later.
    categories_arr = categories.split(',').map((c) => c.trim())
    const last_cat = categories_arr.pop()
    collectionRef = collectionRef.where('categories', 'array-contains', last_cat)
  }

  // Get data and convert to an object we can work with further.
  // doc.data() returns the live cached object, so copy each one before touching it, dropping the
  // fields we do not serve and adding the thumbnail in the same pass. Editing them in place used to
  // strip old_id, reviewers and scale out of the shared cache for every other route.
  const collection = await collectionRef.get()
  const now = Math.floor(Date.now() / 1000)
  let docs = {}
  collection.forEach((doc) => {
    const { old_id, reviewers, scale, staging, ...asset } = doc.data()
    if (staging) return
    if (!includeUpcoming && asset.date_published > now) return
    asset.thumbnail_url = `https://cdn.polyhaven.com/asset_img/thumbs/${doc.id}.png?width=256&height=256`
    docs[doc.id] = asset
  })

  // Categories (2/2)
  // Filter out the remaining assets that aren't in all specifed categories
  for (const cat of categories_arr) {
    for (const id in docs) {
      if (!docs[id].categories.includes(cat)) {
        delete docs[id]
      }
    }
  }

  // New single-path category system: ?category= (inclusive of descendants, canonical or slug path),
  // ?collection=, ?vault=, and any attribute key for this type (e.g. ?weather=clear&indoor=true).
  const { unresolved } = applyFilters(docs, req.query, asset_type)
  if (unresolved) {
    res.status(400).send(`Unknown category: ${escape(String(req.query.category || req.query.cat))}`)
    return
  }

  res.status(200).json(docs)
})

module.exports = router
