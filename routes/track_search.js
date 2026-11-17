import '../utils/env.ts'
import firestore from '../firestore.ts'

export default async function (fastify) {
  fastify.post('/', async (req, reply) => {
    if (req.body.key !== process.env.DL_KEY) {
      return reply.code(403).send({
        error: '403 Forbidden',
        message: 'Incorrect key',
      })
    }

    const data = req.body
    delete data.key
    data.timestamp = new Date().toISOString()

    const db = firestore()

    await db.collection('searches').add(data)

    return reply.code(200).send({
      message: 'OK',
    })
  })
}
