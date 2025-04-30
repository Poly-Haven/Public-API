const express = require('express')
const router = express.Router()
const shuffleArray = require('../utils/shuffleArray')

const firestore = require('../firestore')

const db = firestore()

router.get('/', async (req, res) => {
  const colVaults = await db.collection('vaults').get()
  let vaults = {}
  colVaults.forEach((doc) => {
    vaults[doc.id] = doc.data()
    vaults[doc.id].id = doc.id
  })

  const colMilestones = await db.collection('milestones').get()
  let milestones = {}
  colMilestones.forEach((doc) => {
    milestones[doc.id] = doc.data()
  })

  // Join milestones to vaults based on milestone_id
  Object.keys(vaults).forEach((vaultId) => {
    const vault = vaults[vaultId]
    if (vault.milestone_id && milestones[vault.milestone_id]) {
      vault.milestone = milestones[vault.milestone_id]
      vault.unlocked = milestones[vault.milestone_id].achieved || false
    }
  })

  // Get list of assets in each vault
  for (const id in vaults) {
    const colAssets = await db.collection('assets').where('categories', 'array-contains', `vault: ${id}`).get()
    let assets = []
    colAssets.forEach((doc) => {
      assets.push(doc.id)
    })
    vaults[id].assets = shuffleArray(assets)
  }

  // Sort vaults by milestone.target
  const sortedVaults = Object.values(vaults).sort((a, b) => {
    if (a.milestone && b.milestone) {
      return a.milestone.target - b.milestone.target
    } else if (a.milestone) {
      return -1
    } else if (b.milestone) {
      return 1
    } else {
      return 0
    }
  })

  res.status(200).json(sortedVaults)
})

module.exports = router
