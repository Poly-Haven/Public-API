const crypto = require('crypto')
const admin = require('firebase-admin') // for FieldValue
const firestore = require('../firestore')

require('dotenv').config()

const db = firestore()

// Same trust check as patron_info.js: the Next.js route proves session ownership
// and signs uuid with PATRON_INFO_KEY; we re-derive and compare.
function validate(req, reply) {
  if (!req.body || !req.body.uuid || !req.body.key) {
    reply.code(400).send({ error: '400', message: 'Bad request.' })
    return null
  }
  const uuid = req.body.uuid
  const hash = crypto.createHmac('sha256', process.env.PATRON_INFO_KEY).update(uuid).digest('hex')
  if (req.body.key !== hash) {
    reply.code(403).send({ error: '403 Forbidden', message: 'Incorrect key' })
    return null
  }
  return uuid
}

module.exports = async function (fastify) {
  // Read a user's progress.
  fastify.post('/', async (req, reply) => {
    const uuid = validate(req, reply)
    if (!uuid) return reply
    const doc = await db.collection('course_progress').doc(uuid).get()
    return reply.code(200).send(doc.exists ? doc.data() : { completed: [], lastLecture: null })
  })

  // Update progress: append completed lecture(s) atomically + set the last lecture.
  fastify.patch('/', async (req, reply) => {
    const uuid = validate(req, reply)
    if (!uuid) return reply

    const update = { updatedAt: admin.firestore.FieldValue.serverTimestamp() }
    if (req.body.lastLecture) update.lastLecture = req.body.lastLecture
    if (req.body.completed) {
      const slugs = [].concat(req.body.completed)
      update.completed = admin.firestore.FieldValue.arrayUnion(...slugs)
    }

    await db.collection('course_progress').doc(uuid).set(update, { merge: true })
    return reply.code(200).send({ error: null, message: 'OK' })
  })
}
