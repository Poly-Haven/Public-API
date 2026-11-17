import type { FastifyInstance } from 'fastify'

import type { OpenDoc } from '../types/firestore.ts'

import firestore from '../firestore.ts'
import { sendText } from '../utils/http.ts'

const db = firestore()

export default async function (fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => {
    const collection = await db.collection('timelines').get()
    let docs: Record<string, OpenDoc> = {}
    collection.forEach((doc) => {
      docs[doc.id] = doc.data() as OpenDoc
    })

    return reply.code(200).send(docs)
  })

  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const timeline_id = req.params.id

    if (!timeline_id) {
      return sendText(reply, 400, `No timeline with that ID`)
    }

    const MAX_ID_LENGTH = 50
    if (timeline_id.length > MAX_ID_LENGTH) {
      return sendText(reply, 400, `No timeline with that ID`)
    }

    const validPattern = /^[a-zA-Z0-9_-]+$/
    if (!validPattern.test(timeline_id)) {
      return sendText(reply, 400, `No timeline with that ID`)
    }

    const doc = await db.collection('timelines').doc(timeline_id).get()
    if (!doc.exists) {
      return reply.code(404).send({ error: 'Timeline not found' })
    }
    return reply.code(200).send(doc.data() as OpenDoc)
  })
}
