import escape from 'escape-html'

import firestore from '../firestore.ts'
import { sendText } from '../utils/http.ts'

const db = firestore()

export default async function (fastify) {
  fastify.get('/', async (req, reply) => {
    return sendText(reply, 400, `Please format your request as /author/[id]`)
  })

  fastify.get('/:id', async (req, reply) => {
    const asset_id = req.params.id

    const doc = await db.collection('authors').doc(asset_id).get()
    if (!doc.exists) {
      return sendText(reply, 404, `No author with id ${escape(asset_id)}`)
    } else {
      return reply.code(200).send(doc.data())
    }
  })
}
