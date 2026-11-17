require('dotenv').config()

module.exports = async function (fastify) {
  fastify.post('/', async (req, reply) => {
    if (req.body.key !== process.env.DL_KEY) {
      return reply.code(403).send({
        error: '403 Forbidden',
        message: 'Incorrect key',
      })
    }

    const id = req.body.id

    if (!id) {
      return reply.code(400).send({
        error: '400 Bad Request',
        message: 'bad ID',
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
    const doc = db.collection('gallery').doc(id)
    doc.update({ clicks: increment })

    return reply.code(200).send({
      message: 'OK',
    })
  })
}
