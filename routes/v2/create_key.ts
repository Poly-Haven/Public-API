import '../../utils/env.ts'
import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import firestore from '../../firestore.ts'
import type { ApiKey } from '../../types/firestore.ts'
import { sendError } from '../../utils/v2Cache.ts'

interface CreateKeyBody {
  patron_uid?: unknown
  superhive_uid?: unknown
  rotate?: unknown
}

/**
 * POST /v2/create_key, protected by the master secret. Mints an API key and returns it (the only time the
 * key itself is ever handed out).
 *
 * With `patron_uid` the key belongs to a supporter, and there is only ever one active key per supporter: if
 * one exists it is returned instead of minting another, unless the body has `rotate: true`, which revokes
 * the old one(s) and mints a new one. This is what the website's server calls for a signed-in patron.
 * With `superhive_uid` (or neither) a key is always minted, as before.
 */
export default async function (fastify: FastifyInstance) {
  fastify.post<{ Body: CreateKeyBody }>('/', async (req, reply) => {
    const authHeader = req.headers.authorization
    // An unset secret must not make "Bearer undefined" the password.
    if (!process.env.API_KEY_MASTER || !authHeader || authHeader !== `Bearer ${process.env.API_KEY_MASTER}`) {
      return sendError(reply, 403, 'Incorrect key', { keyed: true })
    }

    const db = firestore()
    const { patron_uid, superhive_uid, rotate } = req.body

    const data: ApiKey = {
      created_at: new Date().toISOString(),
      status: 'active',
    }

    let patronUid: string | undefined
    if (patron_uid) {
      if (typeof patron_uid !== 'string' && typeof patron_uid !== 'number') {
        return sendError(reply, 400, 'patron_uid must be a string', { keyed: true })
      }
      patronUid = String(patron_uid)
      data.patron_uid = patronUid
    }
    if (superhive_uid) {
      data.superhive_uid = superhive_uid as string | number
    }

    // One active key per patron. Read straight from Firestore, not the cache: this must see a key minted
    // a moment ago.
    const existing = patronUid && !superhive_uid ? await activeKeysOf(db, patronUid) : []
    if (existing.length && rotate !== true) {
      // The newest, should a double mint ever have left two.
      const newest = existing.sort((a, b) => (a.data.created_at || '').localeCompare(b.data.created_at || '')).pop()!
      return reply.code(200).send({ data: { ...newest.data, key: newest.key, reused: true }, message: 'OK' })
    }

    let access_token = ''
    let attempts = 0
    const maxAttempts = 5

    do {
      access_token = crypto.randomBytes(32).toString('hex')
      const doc = await db.collection('api_keys').doc(access_token).get()
      if (!doc.exists) break
      attempts++
    } while (attempts < maxAttempts)

    if (attempts >= maxAttempts) {
      return sendError(reply, 500, 'Unable to generate unique token', { keyed: true })
    }

    // Create a separate reference ID for easier lookup and debugging
    data.ref = crypto.randomBytes(6).toString('hex')

    console.log('Creating new API key, ref:', data.ref)

    await db.collection('api_keys').doc(access_token).set(data)

    // Revoked after the new key exists, so a failure part way leaves the patron with a key rather than none.
    // Nodes serve api_keys from a 10 minute cache, so a revoked key can still work for up to that long.
    if (existing.length) {
      const revoked_at = new Date().toISOString()
      for (const old of existing) {
        console.log('Revoking API key, ref:', old.data.ref)
        await db.collection('api_keys').doc(old.key).update({ status: 'revoked', revoked_at })
      }
    }

    return reply.code(200).send({
      data: { ...data, key: access_token, reused: false },
      message: 'OK',
    })
  })
}

const activeKeysOf = async (db: ReturnType<typeof firestore>, patronUid: string) => {
  const snapshot = await db
    .collection('api_keys')
    .where('patron_uid', '==', patronUid)
    .where('status', '==', 'active')
    .get()
  return snapshot.docs.map((doc) => ({ key: doc.id, data: doc.data() as ApiKey }))
}
