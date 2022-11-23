const express = require('express')
const router = express.Router()

const revision = require('child_process').execSync('git rev-list --format=oneline --max-count=1 HEAD').toString().trim()

router.get('/', async (req, res) => {
  res.status(200).json({
    time: Date.now(),
    node: process.env.NODE_ID || 'UNKNOWN',
    commit: revision,
  })
})

module.exports = router
