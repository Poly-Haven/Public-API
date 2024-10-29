const escape = require('escape-html')
const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const db = firestore()

const sortObjByValue = (obj) => {
  const sortedKeys = Object.keys(obj).sort(function (a, b) {
    return obj[b] - obj[a]
  })
  let tempObj = {}
  for (const k of sortedKeys) {
    tempObj[k] = obj[k]
  }
  return tempObj
}

router.get('/', (req, res) => {
  res.status(400).send(`Please format your request as /similar/[asset_id]`)
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

  const num = req.query.num || 6 // Number of similar to return.

  let collectionRef = db.collection('assets')

  const doc = await collectionRef.doc(asset_id).get()
  if (!doc.exists) {
    res.status(404).send(`No asset with id ${escape(asset_id)}`)
    return
  }
  this_asset = doc.data()

  const collection = await collectionRef.get()
  let docs = {}
  collection.forEach((doc) => {
    docs[doc.id] = doc.data()
  })

  // Filter unpublished
  const now = Math.floor(Date.now() / 1000)
  for (const id in docs) {
    if (docs[id].staging || docs[id].date_published > now) {
      delete docs[id]
    }
  }

  similarities = {}
  for (const [slug, asset] of Object.entries(docs)) {
    if (slug === asset_id) continue
    if (slug === asset_id + '_puresky') {
      // Force very high similarity for puresky version
      similarities[slug] = similarities[slug] + 100 || 100
    }
    for (const cat of asset.categories) {
      if (this_asset.categories.includes(cat)) {
        similarities[slug] = similarities[slug] + 1 || 1
      }
    }
    for (const tag of asset.tags) {
      if (this_asset.tags.includes(tag)) {
        similarities[slug] = similarities[slug] + 1 || 1
      }
    }
  }
  similarities = sortObjByValue(similarities)
  similar_slugs = Object.keys(similarities).slice(0, num)

  similar = {}
  for (const s of similar_slugs) {
    similar[s] = docs[s]
    similar[s].similarity = similarities[s]
  }

  res.status(200).json(similar)
})

module.exports = router
