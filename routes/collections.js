const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const db = firestore()

router.get('/', async (req, res) => {
  const collection = await db.collection('collections').orderBy('date_published', 'desc').get()
  let docs = {}
  collection.forEach((doc) => {
    docs[doc.id] = doc.data()
  })
  res.status(200).json(docs)
})

module.exports = router
