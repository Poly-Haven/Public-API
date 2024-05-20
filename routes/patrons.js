const express = require('express')
const router = express.Router()
const isBadWord = require('../utils/isBadWord')
const validator = require('validator')

const firestore = require('../firestore')

router.get('/', async (req, res) => {
  const db = firestore()
  const collection = await db.collection('patrons').where('status', '==', 'active_patron').get()
  let data = {}
  collection.forEach((doc) => {
    data[doc.id] = doc.data()
  })

  const sortedKeys = Object.keys(data).sort((a, b) => data[a].joined.localeCompare(data[b].joined))

  const disallowed = [validator.isEmail, validator.isURL, isBadWord, (name) => name === 'UNKNOWN']

  let patrons = []
  for (const p of sortedKeys) {
    if (!data[p].anon) {
      const name = data[p].display_name || data[p].name
      if (disallowed.some((fn) => fn(name))) {
        continue
      }
      patrons.push([name, data[p].rank])
    }
  }

  res.status(200).json(patrons)
})

module.exports = router
