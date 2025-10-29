const express = require('express')
const router = express.Router()
const crypto = require('crypto')

require('dotenv').config()

router.use(express.json())

router.post('/', async (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader || authHeader !== `Bearer ${process.env.API_KEY_MASTER}`) {
    return res.status(403).json({
      error: '403 Forbidden',
      message: 'Incorrect key',
    })
  }

  const admin = require('firebase-admin')

  if (!admin.apps.length) {
    console.log('Firebase init')
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    })
  }

  const db = admin.firestore()

  // Create new key
  let data = {
    created_at: new Date().toISOString(),
    status: 'active',
  }

  if (req.body.patron_uid) {
    data.patron_uid = req.body.patron_uid
  }
  if (req.body.superhive_uid) {
    data.superhive_uid = req.body.superhive_uid
  }

  let access_token
  let attempts = 0
  const maxAttempts = 5

  do {
    access_token = crypto.randomBytes(32).toString('hex')
    const doc = await db.collection('api_keys').doc(access_token).get()
    if (!doc.exists) break
    attempts++
  } while (attempts < maxAttempts)

  if (attempts >= maxAttempts) {
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Unable to generate unique token',
    })
  }

  // Create a separate reference ID for easier lookup and debugging
  data.ref = crypto.randomBytes(6).toString('hex')

  console.log('Creating new API key, ref:', data.ref)

  await db.collection('api_keys').doc(access_token).set(data)

  res.status(200).json({
    data: data,
    message: 'OK',
  })
})

module.exports = router
