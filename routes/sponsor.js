const crypto = require('crypto');
const escape = require('escape-html');
const express = require('express');
const router = express.Router();

require('dotenv').config()

router.use(express.json())

router.get('/', (req, res) => {
  res.status(400).send(`Please format your request as /sponsor/[id]`);
});

router.get('/:id', async (req, res) => {
  // Get sponsor name & link from given assetID
  const uid = req.params.id;

  const firestore = require('../firestore');
  const db = firestore();

  const doc = await db.collection('patrons').doc(uid).get();
  if (!doc.exists) {
    res.status(404).send(`No sponsor with id ${escape(uid)}`);
  } else {
    const data = doc.data()
    let sponsor = {}
    sponsor.name = data.display_name || data.name
    if (data.url) {
      sponsor.url = data.url
    }
    res.status(200).json(sponsor);
  }
});

router.post('/', async (req, res) => {
  // Add a sponsor to an asset
  if (!req.body.assetID || !req.body.uuid || !req.body.key) {
    res.status(400).json({
      error: "400",
      message: "Bad request."
    })
    return
  }
  const uuid = req.body.uuid
  const hash = crypto.createHmac('md5', process.env.PATRON_INFO_KEY).update(uuid).digest('hex')
  if (req.body.key !== hash) {
    res.status(403).json({
      error: "403 Forbidden",
      message: "Incorrect key"
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

  const doc = db.collection('assets').doc(req.body.assetID);
  doc.update({ sponsors: admin.firestore.FieldValue.arrayUnion(uuid) })

  const logID = Date.now().toString() + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  db.collection('log').doc(logID).set({
    type: "sponsor",
    timestamp: new Date().toISOString(),
    uuid: req.body.uuid,
    assetID: req.body.assetID
  })

  res.status(200).json({ message: "Done" });
});

module.exports = router;