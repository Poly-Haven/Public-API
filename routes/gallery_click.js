const express = require('express')
const router = express.Router()

require('dotenv').config()

router.use(express.json())

router.post('/', async (req, res) => {
  if (req.body.key !== process.env.DL_KEY) {
    res.status(403).json({
      error: '403 Forbidden',
      message: 'Incorrect key',
    })
    return
  }

  const id = req.body.id

  if (!id) {
    res.status(400).json({
      error: '400 Bad Request',
      message: 'bad ID',
    })
    return
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

  const increment = admin.firestore.FieldValue.increment(1)
  const doc = db.collection('gallery').doc(id)
  doc.update({ clicks: increment })

  res.status(200).json({
    message: 'OK',
  })
})

module.exports = router
