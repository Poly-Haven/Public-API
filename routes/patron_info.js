const crypto = require('crypto')
const escape = require('escape-html')
const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const db = firestore()

require('dotenv').config()

router.use(express.json())

// Written by the account page (via polyhaven.com's setPatronInfo), nextcloudInvite and sponsorAsset.
const PATCHABLE_FIELDS = ['anon', 'display_name', 'auto_sponsor', 'notify_email', 'url', 'invite_sent', 'sponsor_tokens']

router.post('/', async (req, res) => {
  if (!req.body.uuid || !req.body.key) {
    res.status(400).json({
      error: '400',
      message: 'Bad request.',
    })
    return
  }

  const uuid = req.body.uuid
  const hash = crypto.createHmac('sha256', process.env.PATRON_INFO_KEY).update(uuid).digest('hex')
  if (req.body.key !== hash) {
    res.status(403).json({
      error: '403 Forbidden',
      message: 'Incorrect key',
    })
    return
  }

  const doc = await db.collection('patrons').doc(uuid).get()
  if (!doc.exists) {
    res.status(404).json({
      error: '404 Not Found',
      message: `No patron with id ${escape(uuid)}`,
    })
  } else {
    res.status(200).json(doc.data())
  }
})

router.patch('/', async (req, res) => {
  if (!req.body.uuid || !req.body.key) {
    res.status(400).json({
      error: '400',
      message: 'Bad request.',
    })
    return
  }

  const uuid = req.body.uuid
  const hash = crypto.createHmac('sha256', process.env.PATRON_INFO_KEY).update(uuid).digest('hex')
  if (req.body.key !== hash) {
    res.status(403).json({
      error: '403 Forbidden',
      message: 'Incorrect key',
    })
    return
  }

  if (!uuid) {
    res.status(400).json({
      error: '400 Bad Request',
      message: 'uuid is undefined',
    })
    return
  }

  // Only fields the website legitimately writes. Everything else on a patrons doc (status, lifetime_cents,
  // joined, tiers...) belongs to the Patreon webhook, and anything that trusts it (early access, Steam
  // keys) depends on users not being able to write it themselves.
  let data = {}
  for (const field of PATCHABLE_FIELDS) {
    if (field in req.body) data[field] = req.body[field]
  }
  if (!Object.keys(data).length) {
    res.status(400).json({
      error: '400 Bad Request',
      message: 'Nothing to update',
    })
    return
  }

  const doc = db.collection('patrons').doc(uuid)
  // Never create a patron: only the webhook does that.
  if (!(await doc.get()).exists) {
    res.status(404).json({
      error: '404 Not Found',
      message: `No patron with id ${escape(uuid)}`,
    })
    return
  }

  // Merge rather than update(), so sponsor_tokens merges into the existing map instead of replacing it.
  await doc.set(data, { merge: true })

  res.status(200).json(data)
})

module.exports = router
