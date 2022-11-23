const express = require('express')
const router = express.Router()
const isBadWord = require('../utils/isBadWord')

const firestore = require('../firestore')

router.get('/', async (req, res) => {
  const db = firestore()
  const collection = await db.collection('patrons').orderBy('lifetime_cents', 'desc').limit(30).get()

  // These are/were corporate sponsors (not individuals)
  const ignored = ['Graswald', 'Andrew_D', 'Luma Animation']

  let patrons = []
  collection.forEach((doc) => {
    const data = doc.data()
    if (!data.anon) {
      const name = data.display_name || data.name
      if (!isBadWord(name) && !ignored.includes(name)) {
        patrons.push([data.uid, name, Date.parse(data.joined)])
      }
    }
  })

  res.set('Cache-Control', `max-age=${30 * 60}`)
  res.status(200).json(patrons)
})

module.exports = router
