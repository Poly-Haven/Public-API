const express = require('express')
const router = express.Router()

const simpleData = async (type) => {
  const firestore = require('../firestore')
  const db = firestore()

  let collection = await db.collection('assets').where('type', '==', type).get()
  let docs = {}
  collection.forEach((doc) => {
    const data = doc.data()
    docs[doc.id] = data.tags.join(';') + ';' + data.categories.join(';')
  })

  return docs
}

router.get('/hdris', async (req, res) => {
  const data = require('../constants/legacy/hdris.json')
  res.status(200).json(data)
})
router.get('/textures', async (req, res) => {
  const data = require('../constants/legacy/textures.json')
  res.status(200).json(data)
})
router.get('/models', async (req, res) => {
  const data = require('../constants/legacy/models.json')
  res.status(200).json(data)
})

router.get('/hdris-simple', async (req, res) => {
  res.status(200).json(await simpleData(0))
})
router.get('/textures-simple', async (req, res) => {
  res.status(200).json(await simpleData(1))
})
router.get('/models-simple', async (req, res) => {
  res.status(200).json(await simpleData(2))
})

module.exports = router
