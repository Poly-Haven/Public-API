import '../utils/env.ts'
import crypto from 'crypto'
import escape from 'escape-html'
import { FieldValue } from 'firebase-admin/firestore'
import type { FastifyInstance } from 'fastify'
import firestore from '../firestore.ts'

import type { CorporateSponsor, Patron } from '../types/firestore.ts'
import { sendText } from '../utils/http.ts'

// What polyhaven.com's sponsorAsset posts. Checked below, so each field is optional here.
interface SponsorBody {
  assetID?: string
  uuid?: string
  key?: string
}

export default async function (fastify: FastifyInstance) {
  fastify.get('/', (req, reply) => {
    return sendText(reply, 400, `Please format your request as /sponsor/[id]`)
  })

  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    // Get sponsor name & link from given assetID
    const uid = req.params.id

    const db = firestore()

    if (uid.startsWith('corp_')) {
      const corp_name = uid.substring('corp_'.length)
      const doc = await db.collection('corporate_sponsors').doc(corp_name).get()
      if (!doc.exists) {
        return sendText(reply, 404, `No corporate sponsor with id ${escape(corp_name)}`)
      } else {
        let sponsor = doc.data() as Partial<CorporateSponsor>
        sponsor.url = sponsor.link
        delete sponsor.link
        delete sponsor.usd
        if ((sponsor.rank as number) <= 0) {
          // Inactive sponsor, don't show logo, only name
          delete sponsor.logo
        }
        delete sponsor.rank
        return reply.code(200).send(sponsor)
      }
    }

    const doc = await db.collection('patrons').doc(uid).get()
    if (!doc.exists) {
      return sendText(reply, 404, `No sponsor with id ${escape(uid)}`)
    } else {
      const data = doc.data() as Patron
      let sponsor: { name?: string; url?: string } = {}
      sponsor.name = data.display_name || data.name
      if (data.url) {
        sponsor.url = data.url
      }
      return reply.code(200).send(sponsor)
    }
  })

  fastify.post<{ Body: SponsorBody }>('/', async (req, reply) => {
    // Add a sponsor to an asset
    if (!req.body.assetID || !req.body.uuid || !req.body.key) {
      return reply.code(400).send({
        error: '400',
        message: 'Bad request.',
      })
    }
    const uuid = req.body.uuid
    const hash = crypto.createHmac('sha256', process.env.PATRON_INFO_KEY!).update(uuid).digest('hex')
    if (req.body.key !== hash) {
      return reply.code(403).send({
        error: '403 Forbidden',
        message: 'Incorrect key',
      })
    }

    const db = firestore()

    const doc = db.collection('assets').doc(req.body.assetID)
    doc.update({ sponsors: FieldValue.arrayUnion(uuid) })

    const logID =
      Date.now().toString() +
      Math.floor(Math.random() * 1000)
        .toString()
        .padStart(3, '0')
    db.collection('log').doc(logID).set({
      type: 'sponsor',
      timestamp: new Date().toISOString(),
      uuid: req.body.uuid,
      assetID: req.body.assetID,
    })

    return reply.code(200).send({ message: 'Done' })
  })
}
