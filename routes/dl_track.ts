import '../utils/env.ts'
import type { FastifyInstance } from 'fastify'
import { FieldValue } from 'firebase-admin/firestore'

import firestore from '../firestore.ts'

// What polyhaven.com's download tracker posts. Every field is checked below, so each is optional here.
interface DlTrackBody {
  key?: string
  ip?: string
  asset_id?: string
  res?: string
  format?: string
}

interface Download {
  datetime: number
  ip: string
  asset_id: string
  res: string
  format?: string
}

export default async function (fastify: FastifyInstance) {
  fastify.post<{ Body: DlTrackBody }>('/', async (req, reply) => {
    if (req.body.key !== process.env.DL_KEY) {
      return reply.code(403).send({
        error: '403 Forbidden',
        message: 'Incorrect key',
      })
    }

    const ip = req.body.ip
    const asset_id = req.body.asset_id
    const resolution = req.body.res
    const format = req.body.format

    if (!ip) {
      return reply.code(400).send({
        error: '400 Bad Request',
        message: 'ip is undefined',
      })
    }
    if (!asset_id) {
      return reply.code(400).send({
        error: '400 Bad Request',
        message: 'asset_id is undefined',
      })
    }
    if (!resolution) {
      return reply.code(400).send({
        error: '400 Bad Request',
        message: 'res is undefined',
      })
    }

    const db = firestore()

    const increment = FieldValue.increment(1)
    const doc = db.collection('assets').doc(asset_id)
    doc.update({ download_count: increment })

    const submitData: Download = {
      datetime: Date.now(),
      ip: ip,
      asset_id: asset_id,
      res: resolution,
    }
    if (format) {
      submitData.format = format
    }
    await db.collection('downloads').add(submitData)
    return reply.code(200).send({
      message: 'OK',
    })
  })
}
