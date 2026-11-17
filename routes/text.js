import escape from 'escape-html'

import firestore from '../firestore.ts'
import { sendText } from '../utils/http.ts'

const db = firestore()

export default async function (fastify) {
  fastify.get('/', async (req, reply) => {
    return sendText(reply, 400, `Please format your request as /text/[id]`)
  })

  fastify.get('/:id', async (req, reply) => {
    const id = req.params.id

    const doc = await db.collection('text').doc(id).get()
    if (!doc.exists) {
      return sendText(reply, 404, `No text with id ${escape(id)}`)
    } else {
      return reply.code(200).send(doc.data())
    }
  })
}
