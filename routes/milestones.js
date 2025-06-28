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

  // Get the number of active patrons (highest value today)
  let count = 0
  const date = new Date()
  const thisMonth = new Date(date.getFullYear(), date.getMonth(), 2).toISOString().slice(0, 7)
  const lastMonth = new Date(date.getFullYear(), date.getMonth() - 1, 2).toISOString().slice(0, 7)
  const colPatronCounts = db.collection('patron_counts')
  let doc = await colPatronCounts.doc(thisMonth).get()
  if (!doc) {
    // If no data for this month yet, use last month
    doc = await colPatronCounts.doc(lastMonth).get()
  }
  const data = doc.data()
  if (data) {
    const latestDay = Object.keys(data).sort((a, b) => parseInt(b) - parseInt(a))[0]
    count = Math.max(...Object.values(data[latestDay]))
  } else {
    console.error(`No patron count data for ${thisMonth} or ${lastMonth}`)
  }

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
