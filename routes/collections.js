const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const db = firestore()

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[array[i], array[j]] = [array[j], array[i]]
  }
  return array
}

router.get('/', async (req, res) => {
  const collection = await db.collection('collections').orderBy('date_published', 'desc').get()
  let docs = {}
  collection.forEach((doc) => {
    docs[doc.id] = doc.data()
  })

  // Get list of assets in each collection
  for (const id in docs) {
    const colAssets = await db.collection('assets').where('categories', 'array-contains', `collection: ${id}`).get()
    let assets = []
    colAssets.forEach((doc) => {
      assets.push(doc.id)
    })
    docs[id].assets = shuffleArray(assets).slice(0, 15)
  }

  res.status(200).json(docs)
})

module.exports = router
