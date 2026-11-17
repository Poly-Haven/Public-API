const crypto = require('crypto')
const escape = require('escape-html')

require('dotenv').config()
const { sendText } = require('../utils/http')

module.exports = async function (fastify) {
  fastify.get('/', (req, reply) => {
    return sendText(reply, 400, `Please format your request as /sponsor/[id]`)
  })

  fastify.get('/:id', async (req, reply) => {
    // Get sponsor name & link from given assetID
    const uid = req.params.id

    const firestore = require('../firestore')
    const db = firestore()

    if (uid.startsWith('corp_')) {
      const corp_name = uid.substring('corp_'.length)
      const doc = await db.collection('corporate_sponsors').doc(corp_name).get()
      if (!doc.exists) {
        return sendText(reply, 404, `No corporate sponsor with id ${escape(corp_name)}`)
      } else {
        let sponsor = doc.data()
        sponsor.url = sponsor.link
        delete sponsor.link
        delete sponsor.usd
        if (sponsor.rank <= 0) {
          // Inactive sponsor, don't show logo, only name
          delete sponsor.logo
        }
        delete sponsor.rank
        return reply.code(200).send(sponsor)
      }
    }

    const doc = await db.collection('patrons').doc(uid).get()
    if (!doc.exists) {
      return sendText(reply, 404, `No sponsor with id ${escape(uid)}`)
    } else {
      const data = doc.data()
      let sponsor = {}
      sponsor.name = data.display_name || data.name
      if (data.url) {
        sponsor.url = data.url
      }
      return reply.code(200).send(sponsor)
    }
  })

  fastify.post('/', async (req, reply) => {
    // Add a sponsor to an asset
    if (!req.body.assetID || !req.body.uuid || !req.body.key) {
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

    const doc = db.collection('assets').doc(req.body.assetID)
    doc.update({ sponsors: admin.firestore.FieldValue.arrayUnion(uuid) })

    const logID =
      Date.now().toString() +
      Math.floor(Math.random() * 1000)
        .toString()
        .padStart(3, '0')
    db.collection('log').doc(logID).set({
      type: 'sponsor',
      timestamp: new Date().toISOString(),
      uuid: req.body.uuid,
      assetID: req.body.assetID,
    })

    return reply.code(200).send({ message: 'Done' })
  })
}
