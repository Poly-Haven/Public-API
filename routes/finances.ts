import type { FastifyInstance } from 'fastify'

import type { FinanceMonth } from '../types/firestore.ts'

import firestore from '../firestore.ts'

const db = firestore()

export default async function (fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => {
    let collectionRef = db.collection('finances')

    const collection = await collectionRef.get()
    let docs: Record<string, FinanceMonth> = {}
    collection.forEach((doc) => {
      docs[doc.id] = doc.data() as FinanceMonth
    })

    return reply.code(200).send(docs)
  })
}
