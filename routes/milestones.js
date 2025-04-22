const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const db = firestore()

router.get('/', async (req, res) => {
  const colMilestones = await db.collection('milestones').get()
  let milestones = []
  colMilestones.forEach((doc) => {
    let data = doc.data()
    data.key = doc.id
    milestones.push(data)
  })

  const colPatrons = db.collection('patrons').where('status', '==', 'active_patron')
  const numPatrons = await colPatrons.get()
  const oneYearAgo = new Date()
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
  let count = 0
  numPatrons.forEach((doc) => {
    const docData = doc.data()
    if (docData.last_charge_date > oneYearAgo.toISOString()) {
      // active_patron is not reliable for old data, so we check last_charge_date as well
      if (docData.lifetime_cents > 0) {
        // Some accounts are caught in limbo and are not really active
        if (docData.cents > 0) {
          // Typically failed payments or blocked accounts
          count++
        }
      }
    }
  })

  // Sort by target
  milestones.sort((a, b) => {
    if (a.target < b.target) return -1
    if (a.target > b.target) return 1
    return 0
  })

  res.status(200).json({ milestones, numPatrons: count })
})

module.exports = router
