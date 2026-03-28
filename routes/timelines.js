const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const db = firestore()

router.get('/', async (req, res) => {
  const collection = await db.collection('timelines').get()
  let docs = {}
  collection.forEach((doc) => {
    docs[doc.id] = doc.data()
  })

  res.status(200).json(docs)
})

router.get('/:id', async (req, res) => {
  const timeline_id = req.params.id

  if (!timeline_id) {
    res.status(400).send(`No timeline with that ID`)
    return
  }

  const MAX_ID_LENGTH = 50
  if (timeline_id.length > MAX_ID_LENGTH) {
    res.status(400).send(`No timeline with that ID`)
    return
  }

  const validPattern = /^[a-zA-Z0-9_-]+$/
  if (!validPattern.test(timeline_id)) {
    res.status(400).send(`No timeline with that ID`)
    return
  }

  const doc = await db.collection('timelines').doc(timeline_id).get()
  if (!doc.exists) {
    return res.status(404).json({ error: 'Timeline not found' })
  }
  res.status(200).json(doc.data())
})

module.exports = router
