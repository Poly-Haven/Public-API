import type { FastifyInstance } from 'fastify'

import type { Patron } from '../types/firestore.ts'

import isBadWord from '../utils/isBadWord.ts'
import validator from 'validator'

import firestore from '../firestore.ts'

export default async function (fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => {
    const db = firestore()
    const collection = await db.collection('patrons').where('status', '==', 'active_patron').get()
    let data: Record<string, Patron & { key?: string }> = {}
    const oneYearAgo = new Date()
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)
    collection.forEach((doc) => {
      const docData = doc.data() as Patron & { key?: string }
      // A missing charge date compares false here, as it always has.
      if ((docData.last_charge_date as string) > oneYearAgo.toISOString()) {
        // active_patron is not reliable for old data, so we check last_charge_date as well
        if (docData.lifetime_cents > 0) {
          // Some accounts are caught in limbo and are not really active
          if (docData.cents > 0) {
            // Typically failed payments or blocked accounts
            docData.key = doc.id
            data[doc.id] = docData
          }
        }
      }
    })

    const sortedKeys = Object.keys(data).sort((a, b) => data[a].joined.localeCompare(data[b].joined))

    const disallowed = [validator.isEmail, validator.isURL, isBadWord, (name: string) => name === 'UNKNOWN']

    let patrons = []
    for (const p of sortedKeys) {
      if (!data[p].anon) {
        const name = (data[p].display_name || data[p].name).trim().replace(/[\u00AD\u200B\u200C\u200D\uFEFF]/g, '') // Remove soft hyphens and zero-width spaces
        if (disallowed.some((fn) => fn(name))) {
          continue
        }
        patrons.push([name, data[p].rank])
      }
    }

    return reply.code(200).send(patrons)
  })
}
