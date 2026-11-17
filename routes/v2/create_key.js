import '../../utils/env.ts'
import crypto from 'crypto'
import firestore from '../../firestore.ts'

export default async function (fastify) {
  fastify.post('/', async (req, reply) => {
    const authHeader = req.headers.authorization
    if (!authHeader || authHeader !== `Bearer ${process.env.API_KEY_MASTER}`) {
      return reply.code(403).send({
        error: '403 Forbidden',
        message: 'Incorrect key',
      })
    }

    const db = firestore()

    // Create new key
    let data = {
      created_at: new Date().toISOString(),
      status: 'active',
    }

    if (req.body.patron_uid) {
      data.patron_uid = req.body.patron_uid
    }
    if (req.body.superhive_uid) {
      data.superhive_uid = req.body.superhive_uid
    }

    let access_token
    let attempts = 0
    const maxAttempts = 5

    do {
      access_token = crypto.randomBytes(32).toString('hex')
      const doc = await db.collection('api_keys').doc(access_token).get()
      if (!doc.exists) break
      attempts++
    } while (attempts < maxAttempts)

    if (attempts >= maxAttempts) {
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Unable to generate unique token',
      })
    }

    // Create a separate reference ID for easier lookup and debugging
    data.ref = crypto.randomBytes(6).toString('hex')

    console.log('Creating new API key, ref:', data.ref)

    await db.collection('api_keys').doc(access_token).set(data)

    return reply.code(200).send({
      data: data,
      message: 'OK',
    })
  })
}
