import '../utils/env.ts'
import type { FastifyInstance } from 'fastify'
import firestore from '../firestore.ts'

export default async function (fastify: FastifyInstance) {
  // The whole body is stored as the search record, so it is open-ended apart from the key.
  fastify.post<{ Body: { key?: unknown; [field: string]: unknown } }>('/', async (req, reply) => {
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
