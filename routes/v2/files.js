const escape = require('escape-html')
const express = require('express')
const router = express.Router()

const cachedFirestore = require('../../utils/cachedFirestore')
const db = cachedFirestore()

router.get('/', (req, res) => {
  res.status(400).send(`Please format your request as /files/[asset_id]`)
})

router.get('/:id', async (req, res) => {
  const asset_id = req.params.id

  // Key must be provided
  const authHeader = req.headers.authorization
  if (!authHeader) {
    return res.status(403).json({
      error: '403 Forbidden',
      message: 'Please provide an API key in the Authorization header',
    })
  }

  if (!asset_id) {
    return res.status(400).json({
      error: '400 Bad Request',
      message: 'No asset ID provided',
    })
  }

  const validPattern = /^[a-zA-Z0-9_-]+$/
  if (!validPattern.test(asset_id)) {
    return res.status(400).json({
      error: '400 Bad Request',
      message: 'Invalid asset ID',
    })
  }

  // Validate API key
  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader
  const allowedKeyChars = 'abcdef0123456789'
  if (apiKey.length !== 64 || [...apiKey].some((c) => !allowedKeyChars.includes(c))) {
    return res.status(403).json({
      error: '403 Forbidden',
      message: 'Invalid API key format',
    })
  }
  let keyDoc = await db.collection('api_keys').doc(apiKey).get()
  if (!keyDoc.exists) {
    return res.status(403).json({
      error: '403 Forbidden',
      message: 'Invalid API key',
    })
  }
  const keyData = keyDoc.data()
  if (keyData.status !== 'active') {
    return res.status(403).json({
      error: '403 Forbidden',
      message: 'API key is not active',
    })
  }

  let includeUpcoming = false

  // For Superhive customers, we always include early access
  if (keyData.superhive_uid) {
    includeUpcoming = true
  }

  // For patrons, we need to check if they have a sufficient tier and that it's active
  // TODO
  // if (keyData.patron_uid) {

  const filesDoc = await db.collection('files').doc(asset_id).get()
  if (!filesDoc.exists) {
    return res.status(404).json({
      error: '404 Not Found',
      message: `No asset with id ${escape(asset_id)}`,
    })
  }

  // Check if the asset is upcoming/early access
  const infoDoc = await db.collection('assets').doc(asset_id).get()
  const infoData = infoDoc.data() // We can assume it exists since the file list exists
  if (infoData.staging) {
    return res.status(403).json({
      error: '403 Forbidden',
      message: 'Asset is in staging',
    })
  }
  const now = Math.floor(Date.now() / 1000)
  if (!includeUpcoming && infoData.date_published > now) {
    return res.status(403).json({
      error: '403 Forbidden',
      message: 'Asset is in early access',
    })
  }

  return res.status(200).json({
    message: 'OK',
    data: filesDoc.data(),
  })
})

module.exports = router
