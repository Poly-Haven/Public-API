const express = require('express')
const router = express.Router()

const revision = require('child_process').execSync('git rev-list --format=oneline --max-count=1 HEAD').toString().trim()

const embeddingIndex = require('../utils/embeddingIndex')
const keywordIndex = require('../utils/keywordIndex')
const workersAI = require('../utils/workersAI')

router.get('/', async (req, res) => {
  res.status(200).json({
    time: Date.now(),
    node: process.env.NODE_ID || 'UNKNOWN',
    commit: revision,
    // The two nodes are not on the same runtime (15.12.0 and 15.14.0 as of writing) and neither has
    // global fetch, which is why utils/workersAI.js uses node-fetch. Reporting it here means the
    // next person to wonder can curl instead of hunting for ssh credentials.
    runtime: process.version,
    // The search index is per-node and built lazily, and admin's /clear_cache fan-out is what keeps
    // it current. Surfacing it here means a node with a stale or failed index is visible without SSH.
    search: {
      index: embeddingIndex.stats(),
      keyword: keywordIndex.stats(),
      queryCache: workersAI.stats(),
    },
  })
})

module.exports = router
