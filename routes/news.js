const express = require('express')
const router = express.Router()

const cachedFirestore = require('../utils/cachedFirestore')

const cachedDb = cachedFirestore()

router.get('/', async (req, res) => {
  const now = new Date().toISOString()
  const collection = await cachedDb.collection('news').get()
  let docs = []
  collection.forEach((doc) => {
    const data = doc.data()
    if (data.active && data.date_start <= now && data.date_end >= now) {
      data.key = doc.id
      docs.push(data)
    }
  })
  res.status(200).json(docs)
})

// News/announcements for the Blender add-on.
router.get('/blender', async (req, res) => {
  const now = new Date().toISOString()
  const collection = await cachedDb.collection('news_blender').get()
  let docs = []
  collection.forEach((doc) => {
    const data = doc.data()
    if (data.active && data.date_start <= now && data.date_end >= now) {
      data.key = doc.id
      docs.push(data)
    }
  })
  res.set('Cache-Control', 'public, max-age=3600') // 1h edge cache
  res.status(200).json(docs)
})

module.exports = router
