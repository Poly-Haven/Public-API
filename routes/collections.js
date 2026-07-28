const express = require('express')
const router = express.Router()
const shuffleArray = require('../utils/shuffleArray')

const firestore = require('../firestore')
const cachedFirestore = require('../utils/cachedFirestore')
const { matchesCollection } = require('../utils/assetFilters')

const db = firestore()
const cachedDb = cachedFirestore()

router.get('/', async (req, res) => {
  const collection = await db.collection('collections').orderBy('date_published', 'desc').get()
  let docs = {}
  collection.forEach((doc) => {
    docs[doc.id] = doc.data()
  })

  // Membership comes from the first-class `collections` field (falling back to the legacy
  // "collection: <id>" category string). One pass over the cached assets instead of a query each.
  const allAssets = await cachedDb.collection('assets').get()
  const byCollection = {}
  allAssets.forEach((doc) => {
    const asset = doc.data()
    for (const id in docs) {
      if (matchesCollection(asset, id)) {
        byCollection[id] = byCollection[id] || []
        byCollection[id].push(doc.id)
      }
    }
  })

  for (const id in docs) {
    docs[id].assets = shuffleArray(byCollection[id] || []).slice(0, 15)
  }

  res.status(200).json(docs)
})

module.exports = router
