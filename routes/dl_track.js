require('dotenv').config()

module.exports = async function (fastify) {
  fastify.post('/', async (req, reply) => {
    if (req.body.key !== process.env.DL_KEY) {
      return reply.code(403).send({
        error: '403 Forbidden',
        message: 'Incorrect key',
      })
    }

    const ip = req.body.ip
    const asset_id = req.body.asset_id
    const resolution = req.body.res
    const format = req.body.format

    if (!ip) {
      return reply.code(400).send({
        error: '400 Bad Request',
        message: 'ip is undefined',
      })
    }
    if (!asset_id) {
      return reply.code(400).send({
        error: '400 Bad Request',
        message: 'asset_id is undefined',
      })
    }
    if (!resolution) {
      return reply.code(400).send({
        error: '400 Bad Request',
        message: 'res is undefined',
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

    const increment = admin.firestore.FieldValue.increment(1)
    const doc = db.collection('assets').doc(asset_id)
    doc.update({ download_count: increment })

    let submitData = {
      datetime: Date.now(),
      ip: ip,
      asset_id: asset_id,
      res: resolution,
    }
    if (format) {
      submitData.format = format
    }
    await db.collection('downloads').add(submitData)
    return reply.code(200).send({
      message: 'OK',
    })
  })
}
