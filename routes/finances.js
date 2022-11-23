const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const db = firestore()

router.get('/', async (req, res) => {
  let collectionRef = db.collection('finances')

  const collection = await collectionRef.get()
  let docs = {}
  collection.forEach((doc) => {
    docs[doc.id] = doc.data()
  })

  res.status(200).json(docs)
})

module.exports = router
