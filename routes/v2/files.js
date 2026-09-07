const escape = require('escape-html')
const express = require('express')
const router = express.Router()

const cachedFirestore = require('../../utils/cachedFirestore')
const validateKey = require('../../utils/validateKey')
const db = cachedFirestore()

router.get('/', (req, res) => {
  res.status(400).send(`Please format your request as /files/[asset_id]`)
})

router.get('/:id', async (req, res) => {
  const asset_id = req.params.id

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
  const keyValidation = await validateKey(req)
  if (!keyValidation.valid) {
    return res.status(keyValidation.error.status).json({
      error: keyValidation.error.error,
      message: keyValidation.error.message,
      meta: {
        keyData: keyValidation.keyData,
      },
    })
  }

  const { includeUpcoming, keyData } = keyValidation

  // A read that fails is not an asset that is missing. These used to be indistinguishable - the
  // cache layer reported a Firestore error as `exists: false` - so a blip answered 404 for an asset
  // that exists. It throws now, and a 503 tells the caller to retry instead of caching a wrong 404.
  let filesDoc
  let infoDoc
  try {
    filesDoc = await db.collection('files').doc(asset_id).get()
    if (filesDoc.exists) {
      infoDoc = await db.collection('assets').doc(asset_id).get()
    }
  } catch (err) {
    console.error(`[V2 FILES] Firestore read failed for ${asset_id}:`, err)
    res.set('Cache-Control', 'no-store')
    return res.status(503).json({
      error: '503 Service Unavailable',
      message: 'Could not look up that asset right now, please retry in a moment',
    })
  }

  if (!filesDoc.exists) {
    return res.status(404).json({
      error: '404 Not Found',
      message: `No asset with id ${escape(asset_id)}`,
    })
  }

  // Check if the asset is upcoming/early access.
  // The files doc existing does not strictly guarantee the assets doc does, and reading `.staging`
  // off a null would throw a TypeError out of an async handler - which on this Node version can
  // take the whole process down rather than just this request.
  const infoData = infoDoc.data()
  if (!infoData) {
    console.error(`[V2 FILES] ${asset_id} has a files doc but no assets doc`)
    return res.status(404).json({
      error: '404 Not Found',
      message: `No asset with id ${escape(asset_id)}`,
    })
  }
  if (infoData.staging) {
    return res.status(403).json({
      error: '403 Forbidden',
      message: 'Asset is in staging',
      meta: {
        includeUpcoming,
        keyData,
      },
    })
  }
  const now = Math.floor(Date.now() / 1000)
  if (!includeUpcoming && infoData.date_published > now) {
    return res.status(403).json({
      error: '403 Forbidden',
      message: 'Asset is in early access',
      meta: {
        includeUpcoming,
        keyData,
      },
    })
  }

  return res.status(200).json({
    message: 'OK',
    data: filesDoc.data(),
    meta: {
      includeUpcoming,
      keyData,
    },
  })
})

module.exports = router
