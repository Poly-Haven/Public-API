const express = require('express');
const router = express.Router();

require('dotenv').config()

router.use(express.json())

router.post('/', async (req, res) => {
  if (req.body.key !== process.env.DL_KEY) {
    res.status(403).json({
      error: "403 Forbidden",
      message: "Incorrect key"
    })
    return
  }

  const ip = req.body.ip
  const asset_id = req.body.asset_id
  const resolution = req.body.res

  if (!ip) {
    res.status(400).json({
      error: "400 Bad Request",
      message: "ip is undefined"
    })
    return
  }
  if (!asset_id) {
    res.status(400).json({
      error: "400 Bad Request",
      message: "asset_id is undefined"
    })
    return
  }
  if (!resolution) {
    res.status(400).json({
      error: "400 Bad Request",
      message: "res is undefined"
    })
    return
  }

  const admin = require('firebase-admin');

  if (!admin.apps.length) {
    console.log("Firebase init")
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      })
    });
  }

  const db = admin.firestore();

  const increment = admin.firestore.FieldValue.increment(1);
  const doc = db.collection('assets').doc(asset_id);
  doc.update({ download_count: increment })

  await db.collection('downloads').add({
    datetime: Date.now(),
    ip: ip,
    asset_id: asset_id,
    res: resolution
  });
  res.status(200).json({
    message: "OK"
  })
});

module.exports = router;