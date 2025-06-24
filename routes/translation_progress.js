const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const db = firestore()

router.get('/', async (req, res) => {
  const doc = await db.collection('locales').doc('translation_progress').get()
  res.status(200).json(doc.data())
})

module.exports = router
