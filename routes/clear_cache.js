const express = require('express')
const router = express.Router()
const cachedFirestore = require('../utils/cachedFirestore')

require('dotenv').config()

router.use(express.json())

router.post('/', async (req, res) => {
  const key = req.body && req.body.key

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
