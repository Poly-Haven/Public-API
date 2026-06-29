const crypto = require('crypto')
const express = require('express')
const router = express.Router()
const admin = require('firebase-admin') // for FieldValue
const firestore = require('../firestore')

require('dotenv').config()

const db = firestore()

router.use(express.json())

// Same trust check as patron_info.js: the Next.js route proves session ownership
// and signs uuid with PATRON_INFO_KEY; we re-derive and compare.
function validate(req, res) {
  if (!req.body || !req.body.uuid || !req.body.key) {
    res.status(400).json({ error: '400', message: 'Bad request.' })
    return null
  }
  const uuid = req.body.uuid
  const hash = crypto.createHmac('sha256', process.env.PATRON_INFO_KEY).update(uuid).digest('hex')
  if (req.body.key !== hash) {
    res.status(403).json({ error: '403 Forbidden', message: 'Incorrect key' })
    return null
  }
  return uuid
}

// Read a user's progress.
router.post('/', async (req, res) => {
  const uuid = validate(req, res)
  if (!uuid) return
  const doc = await db.collection('course_progress').doc(uuid).get()
  res.status(200).json(doc.exists ? doc.data() : { completed: [], lastLecture: null })
})

// Update progress: append completed lecture(s) atomically + set the last lecture.
router.patch('/', async (req, res) => {
  const uuid = validate(req, res)
  if (!uuid) return

  const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() }
  if (req.body.lastLecture) update.lastLecture = req.body.lastLecture
  if (req.body.completed) {
    const slugs = [].concat(req.body.completed)
    update.completed = admin.firestore.FieldValue.arrayUnion(...slugs)
  }

  await db.collection('course_progress').doc(uuid).set(update, { merge: true })
  res.status(200).json({ error: null, message: 'OK' })
})

module.exports = router
