const escape = require('escape-html')
const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const asset_types = require('../asset_types.json')

const db = firestore()

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
    // TODO Reduce Firestore reads by first getting assets according to least-used category. Will need to separately track which categories are least used, maybe with cloud function.
    categories_arr = categories.split(',').map((c) => c.trim())
    const last_cat = categories_arr.pop()
    collectionRef = collectionRef.where('categories', 'array-contains', last_cat)
  }

  // Get data and convert to an object we can work with further
  const collection = await collectionRef.get()
  let docs = {}
  collection.forEach((doc) => {
    docs[doc.id] = doc.data()
  })

  // Filter unpublished
  const now = Math.floor(Date.now() / 1000)
  for (const id in docs) {
    if (docs[id].staging) {
      delete docs[id]
    } else if (!includeUpcoming && docs[id].date_published > now) {
      delete docs[id]
    }
  }

  // Categories (2/2)
  // Filter out the remaining assets that aren't in all specifed categories
  for (const cat of categories_arr) {
    for (const id in docs) {
      if (!docs[id].categories.includes(cat)) {
        delete docs[id]
      }
    }
  }

  // Remove unnecessary data
  const remove_keys = [
    'old_id',
    'reviewers',
    'scale',
    'staging', // It's OK to remove this since we delete truthy staging assets above
  ]
  for (const id in docs) {
    for (const key of remove_keys) {
      delete docs[id][key]
    }
  }

  // Add thumbnail URL
  for (const id in docs) {
    docs[id].thumbnail_url = `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`
  }

  res.status(200).json(docs)
})

module.exports = router
