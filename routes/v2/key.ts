import type { FastifyInstance } from 'fastify'

import { keyAuth, requireKey } from '../../utils/keyAuth.ts'
import { sendOk } from '../../utils/v2Cache.ts'

/**
 * GET /v2/key: what the key in the Authorization header is, for a client (the Blender extension, the website's
 * account page) that wants to show it or switch features on. Never the key document itself.
 */
export default async function (fastify: FastifyInstance) {
  fastify.get('/', { preHandler: requireKey }, async (req, reply) => {
    const { includeUpcoming, keyData } = keyAuth(req)
    const kind = keyData.superhive_uid ? 'superhive' : keyData.patron_uid ? 'patron' : 'other'
    return sendOk(reply, { valid: true, early_access: includeUpcoming, kind })
  })
}
