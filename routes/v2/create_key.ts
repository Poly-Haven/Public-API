import '../../utils/env.ts'
import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import firestore from '../../firestore.ts'
import type { ApiKey } from '../../types/firestore.ts'
import cachedFirestore from '../../utils/cachedFirestore.ts'
import { sendError } from '../../utils/v2Cache.ts'

interface CreateKeyBody {
  patron_uid?: unknown
  superhive_uid?: unknown
  rotate?: unknown
}

type Db = ReturnType<typeof firestore>

/** Whether an Authorization header is `Bearer <API_KEY_MASTER>`, compared in constant time. */
const isMaster = (authHeader: string | undefined): boolean => {
  const secret = process.env.API_KEY_MASTER
  // An unset secret must not make "Bearer undefined" the password.
  if (!secret || !authHeader) return false
  // Digests rather than the strings themselves: timingSafeEqual needs equal lengths, and comparing hashes
  // reveals nothing about where a guess first differs.
  const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest()
  return crypto.timingSafeEqual(sha256(authHeader), sha256(`Bearer ${secret}`))
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
    if (!isMaster(req.headers.authorization)) {
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

    // One active key per patron, unless the request also names a Superhive account (then it is that purchase's
    // key and is minted unconditionally, as it always was).
    if (patronUid && !superhive_uid) {
      const { key, record, reused } = await mintForPatron(db, patronUid, data, rotate === true)
      // The node that minted it must recognise it at once, not after a negative-cache entry from an early
      // lookup expires.
      cachedFirestore.forgetMissing('api_keys', key)
      return reply.code(200).send({ data: { ...record, key, reused }, message: 'OK' })
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
    cachedFirestore.forgetMissing('api_keys', access_token)

    return reply.code(200).send({
      data: { ...data, key: access_token, reused: false },
      message: 'OK',
    })
  })
}

/**
 * Reuses or rotates a patron's one active key inside a transaction. `api_key_patrons/{patron_uid}` is a lock
 * document that every call for that patron reads and (when it mints) writes, so two concurrent calls cannot
 * both see "no key" and mint twice, nor each revoke the key the other just made: Firestore makes one wait for
 * the other and then re-run it against what the first committed. It holds `{ key, updated_at }`, the patron's
 * current key, for anyone looking, but the active keys themselves are still found by querying api_keys, so
 * patrons whose keys predate the lock are covered. Read straight from Firestore, not the cache.
 *
 * Keys that also carry a `superhive_uid` are never reused or revoked here: they belong to a Superhive purchase.
 *
 * A new key is created before the old ones are revoked, in the same commit, so there is no moment (or failure)
 * that leaves the patron with none. Nodes serve api_keys from a 10 minute cache, so a revoked key can still
 * work for up to that long.
 */
const mintForPatron = (db: Db, patronUid: string, base: ApiKey, rotate: boolean) => {
  const lockRef = db.collection('api_key_patrons').doc(patronUid)
  const activeKeys = db.collection('api_keys').where('patron_uid', '==', patronUid).where('status', '==', 'active')

  return db.runTransaction(async (t) => {
    // All reads first; a transaction may not read after it has written. (The function can run more than once.)
    await t.get(lockRef)
    const snapshot = await t.get(activeKeys)
    const existing = snapshot.docs
      .map((doc) => ({ key: doc.id, data: doc.data() as ApiKey }))
      .filter((k) => !k.data.superhive_uid)

    if (existing.length && !rotate) {
      // The newest, should a double mint ever have left two.
      const newest = existing.sort((a, b) => (a.data.created_at || '').localeCompare(b.data.created_at || '')).pop()!
      return { key: newest.key, record: newest.data, reused: true }
    }

    const key = crypto.randomBytes(32).toString('hex')
    const record: ApiKey = { ...base, ref: crypto.randomBytes(6).toString('hex') }
    console.log('Creating new API key, ref:', record.ref)
    // create() fails if the id exists, so a (cosmically unlikely) collision cannot overwrite a live key.
    t.create(db.collection('api_keys').doc(key), record)
    t.set(lockRef, { key, updated_at: record.created_at })

    const revoked_at = new Date().toISOString()
    for (const old of existing) {
      console.log('Revoking API key, ref:', old.data.ref)
      t.update(db.collection('api_keys').doc(old.key), { status: 'revoked', revoked_at })
    }
    return { key, record, reused: false }
  })
}
