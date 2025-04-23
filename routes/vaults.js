const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const db = firestore()

router.get('/', async (req, res) => {
  const colVaults = await db.collection('vaults').get()
  let vaults = {}
  colVaults.forEach((doc) => {
    vaults[doc.id] = doc.data()
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

  res.status(200).json(vaults)
})

module.exports = router
