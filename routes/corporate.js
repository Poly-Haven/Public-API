const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const db = firestore()

router.get('/', async (req, res) => {
  const collection = await db.collection('corporate_sponsors').where('rank', '>', 0).get()
  let docs = {}
  collection.forEach((doc) => {
    docs[doc.id] = doc.data()
  })

  // Shuffle the sponsors
  const entries = Object.entries(docs)
  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[entries[i], entries[j]] = [entries[j], entries[i]]
  }
  const shuffledDocs = Object.fromEntries(entries)

  res.status(200).json(shuffledDocs)
})

module.exports = router
