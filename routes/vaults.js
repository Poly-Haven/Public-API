const express = require('express')
const router = express.Router()
const shuffleArray = require('../utils/shuffleArray')
const sortObjBySubObjProp = require('../utils/sortObjBySubObjProp')

const firestore = require('../firestore')
const cachedFirestore = require('../utils/cachedFirestore')
const { matchesVault } = require('../utils/assetFilters')
const { vaultStatus } = require('../utils/vaultStatus')

const db = firestore()
const cachedDb = cachedFirestore()

router.get('/', async (req, res) => {
  const colVaults = await db.collection('vaults').get()
  let vaults = {}
  colVaults.forEach((doc) => {
    // Upcoming vaults exist so their assets can be uploaded before the vault is announced. They
    // have no public existence yet, so they never reach this response - and because /vaults is
    // what the website 404s unknown vault pages against, that also keeps /vaults/<id> hidden.
    if (vaultStatus(doc.data()) === 'upcoming') return
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
      vault.target = milestones[vault.milestone_id].target || 0
      delete vault.milestone.target
    }
    // A vault whose milestone_id is missing or dangling would otherwise have no target at all,
    // which sorts as NaN below and renders as "NaN patrons to go" on the website.
    if (typeof vault.target !== 'number') vault.target = 0
  })

  // Membership comes from the first-class `vault` field (falling back to the legacy "vault: <id>"
  // category string). One pass over the cached assets instead of a query per vault.
  const allAssets = await cachedDb.collection('assets').get()
  const byVault = {}
  allAssets.forEach((doc) => {
    const asset = doc.data()
    if (asset.staging) return
    for (const id in vaults) {
      if (matchesVault(asset, id)) {
        byVault[id] = byVault[id] || []
        byVault[id].push(doc.id)
      }
    }
  })

  for (const id in vaults) {
    vaults[id].assets = shuffleArray(byVault[id] || [])
  }

  // Sort vaults by milestone.target
  const sortedVaults = sortObjBySubObjProp(vaults, 'target', true)

  res.status(200).json(sortedVaults)
})

module.exports = router
