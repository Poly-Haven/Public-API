const express = require('express')
const router = express.Router()

const cachedFirestore = require('../../utils/cachedFirestore')
const validateKey = require('../../utils/validateKey')
const db = cachedFirestore()

router.get('/', async (req, res) => {
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

  const returnData = {
    version: 'v1',
    blocklist: [],
    data: [],
  }

  let collectionRef = db.collection('extension')

  const collection = await collectionRef.get()
  const compatibleVersions = {}
  collection.forEach((doc) => {
    const ext = doc.data()
    // if (ext.version === '2.0.0') return // DEBUG
    const isCompatible =
      !req.query.blender_version ||
      ext.blender_version_min.localeCompare(req.query.blender_version, undefined, {
        numeric: true,
        sensitivity: 'base',
      }) <= 0

    if (isCompatible) {
      compatibleVersions[doc.id] = ext
    }
  })

  // If blender_version is provided, return only the highest compatible version
  if (req.query.blender_version) {
    const highestVersion = Object.keys(compatibleVersions).sort((a, b) => {
      return compatibleVersions[b].version.localeCompare(compatibleVersions[a].version, undefined, {
        numeric: true,
        sensitivity: 'base',
      })
    })[0]
    if (highestVersion) {
      returnData.data.push(compatibleVersions[highestVersion])
    }
  } else {
    // Otherwise, return all versions
    for (const id in compatibleVersions) {
      returnData.data.push(compatibleVersions[id])
    }
  }

  return res.status(200).json({
    ...returnData,
    message: 'OK',
    meta: {
      includeUpcoming,
      keyData,
    },
  })
})

module.exports = router
