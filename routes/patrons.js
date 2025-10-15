const express = require('express')
const router = express.Router()
const isBadWord = require('../utils/isBadWord')
const validator = require('validator')

const firestore = require('../firestore')

router.get('/', async (req, res) => {
  const db = firestore()
  const collection = await db.collection('patrons').where('status', '==', 'active_patron').get()
  let data = {}
  const oneYearAgo = new Date()
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
  collection.forEach((doc) => {
    const docData = doc.data()
    if (docData.last_charge_date > oneYearAgo.toISOString()) {
      // active_patron is not reliable for old data, so we check last_charge_date as well
      if (docData.lifetime_cents > 0) {
        // Some accounts are caught in limbo and are not really active
        if (docData.cents > 0) {
          // Typically failed payments or blocked accounts
          docData.key = doc.id
          data[doc.id] = docData
        }
      }
    }
  })

  const sortedKeys = Object.keys(data).sort((a, b) => data[a].joined.localeCompare(data[b].joined))

  const disallowed = [validator.isEmail, validator.isURL, isBadWord, (name) => name === 'UNKNOWN']

  let patrons = []
  for (const p of sortedKeys) {
    if (!data[p].anon) {
      const name = (data[p].display_name || data[p].name).trim().replace(/[\u00AD\u200B\u200C\u200D\uFEFF]/g, '') // Remove soft hyphens and zero-width spaces
      if (disallowed.some((fn) => fn(name))) {
        continue
      }
      patrons.push([name, data[p].rank])
    }
  }

  res.status(200).json(patrons)
})

module.exports = router
