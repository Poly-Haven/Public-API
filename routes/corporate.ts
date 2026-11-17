import type { FastifyInstance } from 'fastify'

import type { CorporateSponsor } from '../types/firestore.ts'

import firestore from '../firestore.ts'

const db = firestore()

export default async function (fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => {
    const collection = await db.collection('corporate_sponsors').where('rank', '>', 0).get()
    let docs: Record<string, CorporateSponsor> = {}
    collection.forEach((doc) => {
      docs[doc.id] = doc.data() as CorporateSponsor
    })

    // Shuffle the sponsors
    const entries = Object.entries(docs)
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[entries[i], entries[j]] = [entries[j], entries[i]]
    }
    const shuffledDocs = Object.fromEntries(entries)

    return reply.code(200).send(shuffledDocs)
  })
}
