const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const patreon_tiers = require('../constants/patreon_tiers.json')

require('dotenv').config()

const bodyParser = require('body-parser')

router.use(bodyParser.text({ type: '*/*' }));

const centsToRank = (c) => {
  if (c <= 300) {
    return 1
  } else if (c <= 500) {
    return 2
  } else if (c <= 1000) {
    return 3
  } else if (c <= 5000) {
    return 4
  }
  return 5
}

const grantToken = (data, previousData) => {
  let granted = false

  if (data.lifetime_cents <= previousData.lifetime_cents) {
    // No payment made, probably just user updated
    return [data, granted]
  }

  const now = new Date()
  const tokenKey = `${now.getFullYear()}-${now.getMonth() + 1}`

  if (previousData.sponsor_tokens && Object.keys(previousData.sponsor_tokens).includes(tokenKey)) {
    // Token already used
    return [data, granted]
  }

  data.sponsor_tokens = {}
  data.sponsor_tokens[tokenKey] = false
  granted = true
  return [data, granted]
}

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

  let uid = "";
  try {
    uid = data.data.relationships.user.data.id;
  } catch (e) {
    res.status(400).json({
      error: "400",
      message: "Couldn't get uid"
    })
    return
  }

  let patron = {}
  patron.uid = uid
  patron.name = data.data.attributes.full_name.trim()
  patron.joined = data.data.attributes.pledge_relationship_start
  patron.cents = data.data.attributes.currently_entitled_amount_cents
  patron.rank = centsToRank(patron.cents)
  patron.lifetime_cents = data.data.attributes.lifetime_support_cents
  patron.last_charge_date = data.data.attributes.last_charge_date
  patron.last_charge_status = data.data.attributes.last_charge_status
  patron.next_charge_date = data.data.attributes.next_charge_date
  patron.status = data.data.attributes.patron_status
  patron.last_edited = Date.now()
  const entitled_tiers = data.data.relationships.currently_entitled_tiers.data
  if (entitled_tiers.length > 0) {
    // When a user deletes their pledge, entitled_tiers is empty, even though they are entitled for the rest of the month they paid for. So we don't set their tiers if this is the case.
    patron.tiers = []
    for (const t of entitled_tiers) {
      patron.tiers.push(t.id)
    }
  }

  if (patron.tiers && patron.status === "active_patron") {
    for (const tier of patron.tiers) {
      if (Object.keys(patreon_tiers).includes(tier)) {
        if (patreon_tiers[tier].rewards.includes("Sponsor")) {
          const previousDoc = await db.collection('patrons').doc(uid).get()
          let previousData = null
          if (previousDoc.exists) {
            previousData = previousDoc.data()
          }
          const [p, granted] = grantToken(patron, previousData)
          patron = p
          if (granted) {
            const logID = Date.now().toString() + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
            db.collection('log').doc(logID).set({
              type: "granttoken",
              timestamp: new Date().toISOString(),
              uuid: patron.uid,
            })
          }
          break
        }
      }
    }
  }

  db.collection('patrons').doc(uid).set(patron, { merge: true })

  res.status(200).json({
    message: "OK"
  })
});

module.exports = router;