const express = require('express')
const router = express.Router()

require('dotenv').config()

router.use(express.json())

router.get('/', async (req, res) => {
  /*
  Expected data:
  {
    "status": "complete",
    "event_type": "after_sale",
    "order_item_id": 12345,
    "order_id": 12345,
    "order_created_at": "2025-10-21 07:50:20 -0500",
    "user_id": 12345,
    "product_id": 12345,
    "product_name": "PRODUCT NAME",
    "product_variant_id": 12345,
    "product_variant_name": "PRODUCT VARIANT NAME"
  }
    */

  // Validate body data
  if (!req.body || req.body.event_type !== 'after_sale' || req.body.user_id === undefined) {
    return res.status(400).json({
      error: '400 Bad Request',
      message: 'Invalid request body',
    })
  }

  // Dump the data into Firestore
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

  /*
  TODO:
  Don't just dump the data, we need to responde with the text file that includes the extension URL and access token, and obviously also create the access token.
  */

  const db = admin.firestore()
  const document = {}
  document.hook = req.body
  document.access_token_created = false
  document.req_headers = req.headers
  document.method = req.method
  document.received_at = new Date().toISOString()
  document.ip = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress
  await db.collection('superhive_hooks').add(document)

  res.status(200).json({
    document,
    message: 'OK',
  })
})

module.exports = router
