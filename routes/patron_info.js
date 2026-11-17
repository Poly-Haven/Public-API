import '../utils/env.ts'
import crypto from 'crypto'
import escape from 'escape-html'

import firestore from '../firestore.ts'

const db = firestore()

// Written by the account page (via polyhaven.com's setPatronInfo), nextcloudInvite and sponsorAsset.
const PATCHABLE_FIELDS = [
  'anon',
  'display_name',
  'auto_sponsor',
  'notify_email',
  'url',
  'invite_sent',
  'sponsor_tokens',
]

export default async function (fastify) {
  fastify.post('/', async (req, reply) => {
    if (!req.body.uuid || !req.body.key) {
      return reply.code(400).send({
        error: '400',
        message: 'Bad request.',
      })
    }

    const uuid = req.body.uuid
    const hash = crypto.createHmac('sha256', process.env.PATRON_INFO_KEY).update(uuid).digest('hex')
    if (req.body.key !== hash) {
      return reply.code(403).send({
        error: '403 Forbidden',
        message: 'Incorrect key',
      })
    }

    const doc = await db.collection('patrons').doc(uuid).get()
    if (!doc.exists) {
      return reply.code(404).send({
        error: '404 Not Found',
        message: `No patron with id ${escape(uuid)}`,
      })
    } else {
      return reply.code(200).send(doc.data())
    }
  })

  fastify.patch('/', async (req, reply) => {
    if (!req.body.uuid || !req.body.key) {
      return reply.code(400).send({
        error: '400',
        message: 'Bad request.',
      })
    }

    const uuid = req.body.uuid
    const hash = crypto.createHmac('sha256', process.env.PATRON_INFO_KEY).update(uuid).digest('hex')
    if (req.body.key !== hash) {
      return reply.code(403).send({
        error: '403 Forbidden',
        message: 'Incorrect key',
      })
    }

    if (!uuid) {
      return reply.code(400).send({
        error: '400 Bad Request',
        message: 'uuid is undefined',
      })
    }

    // Only fields the website legitimately writes. Everything else on a patrons doc (status, lifetime_cents,
    // joined, tiers...) belongs to the Patreon webhook, and anything that trusts it (early access, Steam
    // keys) depends on users not being able to write it themselves.
    let data = {}
    for (const field of PATCHABLE_FIELDS) {
      if (field in req.body) data[field] = req.body[field]
    }
    if (!Object.keys(data).length) {
      return reply.code(400).send({
        error: '400 Bad Request',
        message: 'Nothing to update',
      })
    }

    const doc = db.collection('patrons').doc(uuid)
    // Never create a patron: only the webhook does that.
    if (!(await doc.get()).exists) {
      return reply.code(404).send({
        error: '404 Not Found',
        message: `No patron with id ${escape(uuid)}`,
      })
    }

    // Merge rather than update(), so sponsor_tokens merges into the existing map instead of replacing it.
    await doc.set(data, { merge: true })

    return reply.code(200).send(data)
  })
}
