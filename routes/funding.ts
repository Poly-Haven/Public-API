import type { FastifyInstance } from 'fastify'

import type { CorporateSponsor, OpenDoc, Patron } from '../types/firestore.ts'

import { patreonTiers as patreon_tiers } from '../utils/schemas.ts'

import firestore from '../firestore.ts'

export default async function (fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => {
    const db = firestore()

    let corporateTierIDs: string[] = []
    for (const [id, data] of Object.entries(patreon_tiers)) {
      if (data.rewards.includes('Corporate Silver')) {
        corporateTierIDs.push(id)
      }
    }

    const colPatrons = await db.collection('patrons').where('status', '==', 'active_patron').get()
    let numPatrons = 0
    let sumCents = 0
    colPatrons.forEach((doc) => {
      const data = doc.data() as Patron
      let ignore = false
      if (data.tiers && data.tiers.some((ai) => corporateTierIDs.includes(ai))) {
        ignore = true
      }
      if (!ignore) {
        numPatrons += 1
        sumCents += data.cents || 0
      }
    })

    const colCorp = await db.collection('corporate_sponsors').where('rank', '>', 0).get()
    let numCorps = 0
    let sumCorp = 0
    colCorp.forEach((doc) => {
      numCorps += 1
      sumCorp += (doc.data() as CorporateSponsor).usd || 0
    })

    const totalFunds = sumCents / 100 + sumCorp

    const colGoals = await db
      .collection('goals')
      .where('target', '>', totalFunds)
      .orderBy('target', 'asc')
      .limit(1)
      .get()
    let goals: OpenDoc[] = []
    colGoals.forEach((doc) => {
      goals.push(doc.data() as OpenDoc)
    })
    const currentGoal = goals[0] || null

    const funding = {
      numPatrons: numPatrons,
      patronFunds: Math.floor(sumCents / 100),
      numCorps: numCorps,
      corpFunds: Math.floor(sumCorp),
      totalFunds: Math.floor(totalFunds),
      goal: currentGoal,
    }

    return reply.code(200).send(funding)
  })
}
