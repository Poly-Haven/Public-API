const express = require('express');
const crypto = require('crypto');
const router = express.Router();

require('dotenv').config()

const bodyParser = require('body-parser')

router.use(bodyParser.text({ type: '*/*' }));

router.post('/', async (req, res) => {
  const webhookSecret = process.env.PATREON_HOOK_SECRET;
  const hash = crypto.createHmac('md5', webhookSecret).update(req.body).digest('hex');
  const success = (req.header('x-patreon-signature') === hash);
  let data = JSON.parse(req.body);
  data.hook = req.header('x-patreon-event');

  if (!success) {
    console.log('Signature received: ' + req.header('x-patreon-signature'));
    console.log('Signature generated: ' + hash);
    console.log('Signature validation status: ' + success);

    res.status(403).json({
      error: "403 Forbidden",
      message: "Incorrect secret"
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

  const docID = Date.now().toString() + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  db.collection('patreon_hooks').doc(docID).set(data)

  res.status(200).json({
    message: "OK"
  })
});

module.exports = router;