import type { FastifyInstance } from 'fastify'

import type { OpenDoc } from '../types/firestore.ts'

import firestore from '../firestore.ts'

const db = firestore()

export default async function (fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => {
    const collection = await db.collection('community_prizes').get()
    let docs: Record<string, OpenDoc> = {}
    collection.forEach((doc) => {
      docs[doc.id] = doc.data() as OpenDoc
    })

    return reply.code(200).send(docs)
  })
}
