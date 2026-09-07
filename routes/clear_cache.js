const express = require('express')
const router = express.Router()
const cachedFirestore = require('../utils/cachedFirestore')

require('dotenv').config()

router.use(express.json())

router.post('/', async (req, res) => {
  const key = req.body && req.body.key

  // Refuse outright if the server has no key configured. Without this the comparison below is
  // `undefined !== undefined`, which is false - so a missing DL_KEY would silently turn this into
  // an unauthenticated endpoint that lets anyone flush every node's cache.
  if (!process.env.DL_KEY) {
    console.error('[CLEAR CACHE] DL_KEY is not configured; refusing to clear')
    res.status(500).json({
      error: '500 Internal Server Error',
      message: 'Cache clearing is not configured on this node',
    })
    return
  }

  if (key !== process.env.DL_KEY) {
    res.status(403).json({
      error: '403 Forbidden',
      message: 'Incorrect key',
    })
    return
  }

  const cleared = cachedFirestore.clearCache()

  res.status(200).json({
    message: 'OK',
    node: process.env.NODE_ID || 'UNKNOWN',
    cache: {
      scope: 'local',
      ...cleared,
    },
  })
})

module.exports = router
