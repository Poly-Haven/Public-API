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

  // Get the number of active patrons (highest value in last 24 hours)
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const patronCounts = await db.collection('patron_count').where('date', '>=', yesterday.toISOString()).get()
  const count = patronCounts.docs.reduce((max, doc) => {
    const c = doc.data().count
    return c > max ? c : max
  }, 0)

  // Get number of early access assets
  let numEaAssets = 0
  const now = Math.floor(Date.now() / 1000)
  const colAssets = await db.collection('assets').get()
  colAssets.forEach((doc) => {
    const data = doc.data()
    if (!data.staging && data.date_published > now) {
      numEaAssets++
    }
  })

  // Sort by target
  milestones.sort((a, b) => {
    if (a.target < b.target) return -1
    if (a.target > b.target) return 1
    return 0
  })

  res.status(200).json({ numPatrons: count, numEaAssets: numEaAssets, milestones })
})

module.exports = router
