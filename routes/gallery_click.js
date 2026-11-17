import '../utils/env.ts'
import { FieldValue } from 'firebase-admin/firestore'
import firestore from '../firestore.ts'

export default async function (fastify) {
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

    const db = firestore()

    const increment = FieldValue.increment(1)
    const doc = db.collection('gallery').doc(id)
    doc.update({ clicks: increment })

    return reply.code(200).send({
      message: 'OK',
    })
  })
}
