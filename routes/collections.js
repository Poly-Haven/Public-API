const express = require('express')
const router = express.Router()

const sortObjBySubObjProp = require('../utils/sortObjBySubObjProp')
const firestore = require('../firestore')

const db = firestore()

router.get('/', async (req, res) => {
  const collection = await db.collection('collections').orderBy('date_published', 'desc').get()
  let docs = {}
  collection.forEach((doc) => {
    docs[doc.id] = doc.data()
  })

  // Get list of assets in each collection
  for (const id in docs) {
    const colAssets = await db.collection('assets').where('tags', 'array-contains', `collection: ${id}`).get()
    let assets = {}
    colAssets.forEach((doc) => {
      assets[doc.id] = doc.data()
    })
    const sortedKeys = Object.keys(sortObjBySubObjProp(assets, 'download_count'))
    docs[id].assets = sortedKeys.slice(0, 10)
  }

  res.status(200).json(docs)
})

module.exports = router
