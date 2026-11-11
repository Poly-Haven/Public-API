// Project Lighthouse Steam keys for patrons. Design: info/steam_key_claims_plan.md (Poly Haven root).
//
// Called only by polyhaven.com's /api/lighthouseKey proxy, which signs the Patreon user ID from the
// Auth0 session with PATRON_INFO_KEY, exactly like /patron_info. Everything is POST because the zone
// force-caches GETs (404s and no-store included) for 12h, and Cloudflare never caches a POST.
//
// The same Firestore layout is used by admin.polyhaven.com (utils/steamKeys.ts, staff hand-outs and the
// switches) and community.polyhaven.com (utils/steamKeys.ts, contributor claims). Keep them in step.

const crypto = require('crypto')
const express = require('express')
const admin = require('firebase-admin')
const router = express.Router()

const firestore = require('../firestore')

// Plain firestore(), never cachedFirestore: claim and patron reads must be fresh.
const db = firestore()
const FieldValue = admin.firestore.FieldValue

require('dotenv').config()

router.use(express.json())

const PREFIX = process.env.STEAM_KEYS_COLLECTION_PREFIX || ''
const COL = {
  keys: `${PREFIX}steam_keys`,
  claims: `${PREFIX}steam_key_claims`,
  identities: `${PREFIX}steam_key_identities`,
  config: `${PREFIX}steam_key_config`,
}
const CONFIG_DOC = 'lighthouse'

// Approved 2026-11-11. Changing the wording means bumping the version: claims record which one was agreed to.
const TERMS_VERSION = '2026-11-11'
const TERMS_TEXT =
  'This key is a personal licence for you alone. By claiming it you agree not to sell, trade or give the key, or the copy of Project Lighthouse it unlocks, to anyone else. It gives you access to the closed beta and a full copy of the game on release.'
const TERMS_HASH = crypto.createHash('sha256').update(TERMS_TEXT).digest('hex')

const MIN_LIFETIME_CENTS = 300
const JOINED_BEFORE = Date.parse('2027-03-27T00:00:00Z') // release date
const CONFIG_TTL_MS = 15 * 1000
const CLAIM_ATTEMPTS = 5

// ---------------------------------------------------------------------------------------------------

let configCache = { at: 0, config: null }

const cleanIds = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [])

// Fails closed: a missing doc, a read error or anything but a literal `true` means closed.
const parseConfig = (data) => ({
  open: data?.claims_open?.patron === true,
  testers: cleanIds(data?.test_ids?.patreon),
})

const getConfig = async () => {
  if (configCache.config && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.config
  let config
  try {
    const doc = await db.collection(COL.config).doc(CONFIG_DOC).get()
    config = parseConfig(doc.exists ? doc.data() : null)
  } catch (err) {
    console.error('[LIGHTHOUSE KEY] Could not read config, treating as closed:', err)
    return parseConfig(null) // not cached, so the next request retries
  }
  configCache = { at: Date.now(), config }
  return config
}

// Same predicate as utils/validateKey.js
const isActivePatron = (p) => {
  if (p.status === 'active_patron') return true
  if (p.last_charge_status === 'Paid' && p.last_charge_date) {
    const daysAgo = (Date.now() - Date.parse(p.last_charge_date)) / 1000 / 60 / 60 / 24
    if (daysAgo <= 31 || (p.yearly_pledge && daysAgo <= 365)) return true
  }
  return false
}

// null when eligible, otherwise the reason
const ineligibility = (patron) => {
  if (!patron) return 'not_patron'
  if (!isActivePatron(patron)) return 'not_active'
  if ((patron.lifetime_cents || 0) < MIN_LIFETIME_CENTS) return 'under_minimum'
  const joined = Date.parse(patron.joined)
  if (!(joined < JOINED_BEFORE)) return 'joined_too_late'
  return null
}

const pickRange = (pool) => [`${pool}|`, `${pool}|~`]

const findAvailable = async (pool) => {
  const [lo, hi] = pickRange(pool)
  const r = `${pool}|${Math.random().toFixed(12)}`
  const keys = db.collection(COL.keys)
  let snap = await keys.where('pick', '>=', r).where('pick', '<', hi).orderBy('pick').limit(1).get()
  if (snap.empty) snap = await keys.where('pick', '>=', lo).where('pick', '<', r).orderBy('pick').limit(1).get()
  return snap.empty ? null : snap.docs[0].id
}

const validUuid = (uuid) => typeof uuid === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(uuid)

// Authenticates the request and works out who this is and what they're allowed to do. Returns null when
// the request should get the same 404 as an unknown route.
const resolve = async (req, res) => {
  const { uuid, key } = req.body || {}
  if (!validUuid(uuid) || typeof key !== 'string') return null
  const hash = crypto.createHmac('sha256', process.env.PATRON_INFO_KEY).update(uuid).digest('hex')
  const given = Buffer.from(key)
  const expected = Buffer.from(hash)
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null

  const config = await getConfig()
  const tester = config.testers.includes(uuid)
  const claimId = `patron_${uuid}`
  const identityId = `patreon_${uuid}`

  const [claimDoc, identityDoc] = await Promise.all([
    db.collection(COL.claims).doc(claimId).get(),
    db.collection(COL.identities).doc(identityId).get(),
  ])

  // Closed: only testers and people who already claimed get an answer.
  if (!config.open && !tester && !claimDoc.exists) return null

  return { uuid, config, tester, testMode: !config.open && tester, claimId, identityId, claimDoc, identityDoc }
}

const claimedResponse = (claim) => ({ state: 'claimed', key: claim.key, test: claim.test === true })

const status = async (ctx) => {
  if (ctx.claimDoc.exists) return claimedResponse(ctx.claimDoc.data())
  if (!ctx.testMode && ctx.identityDoc.exists && ctx.identityDoc.data().claim_id !== ctx.claimId) {
    return { state: 'claimed_elsewhere' }
  }
  const patronDoc = await db.collection('patrons').doc(ctx.uuid).get()
  const reason = ineligibility(patronDoc.exists ? patronDoc.data() : null)
  const base = { terms: { version: TERMS_VERSION, text: TERMS_TEXT }, test: ctx.testMode }
  if (reason && !ctx.testMode) return { state: reason }
  const pool = ctx.testMode ? 'private' : 'patron'
  if (!(await findAvailable(pool))) return { ...base, state: 'sold_out' }
  // Testers skip eligibility so the happy path can be tried; would_be says what a real patron would see.
  return { ...base, state: 'eligible', ...(ctx.testMode && reason ? { would_be: reason } : {}) }
}

const claim = async (ctx, email) => {
  const status0 = await status(ctx)
  if (status0.state !== 'eligible') return status0

  const pool = ctx.testMode ? 'private' : 'patron'
  const patronDoc = await db.collection('patrons').doc(ctx.uuid).get()
  const patron = patronDoc.exists ? patronDoc.data() : {}
  const claimRef = db.collection(COL.claims).doc(ctx.claimId)
  const identityRef = db.collection(COL.identities).doc(ctx.identityId)
  const configRef = db.collection(COL.config).doc(CONFIG_DOC)

  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    const candidate = await findAvailable(pool)
    if (!candidate) return { state: 'sold_out' }
    const keyRef = db.collection(COL.keys).doc(candidate)

    const result = await db.runTransaction(async (t) => {
      const [configDoc, claimDoc, identityDoc, keyDoc] = await t.getAll(configRef, claimRef, identityRef, keyRef)

      // Re-check the switch inside the transaction, so nothing lands after a side is closed.
      const config = parseConfig(configDoc.exists ? configDoc.data() : null)
      const testMode = !config.open && config.testers.includes(ctx.uuid)
      if (!config.open && !testMode) return { state: 'closed' }
      if (testMode !== ctx.testMode) return { state: 'retry_now' }

      if (claimDoc.exists) return claimedResponse(claimDoc.data())
      if (!testMode && identityDoc.exists && identityDoc.data().claim_id !== ctx.claimId) {
        return { state: 'claimed_elsewhere' }
      }
      const k = keyDoc.exists ? keyDoc.data() : null
      if (!k || k.status !== 'available' || k.pool !== pool) return null // someone beat us to it

      const record = {
        key: candidate,
        pool,
        method: 'patron',
        name: patron.name || null,
        email: typeof email === 'string' && email.length < 320 ? email : null,
        patreon_id: ctx.uuid,
        terms_version: TERMS_VERSION,
        terms_hash: TERMS_HASH,
        agreed_at: FieldValue.serverTimestamp(),
        claimed_at: FieldValue.serverTimestamp(),
      }
      if (testMode) record.test = true
      t.update(keyRef, { status: 'claimed', pick: FieldValue.delete(), claim_id: ctx.claimId, claimed_at: FieldValue.serverTimestamp() })
      t.create(claimRef, record)
      // Test claims write no identity lock, so a tester can try both sides.
      if (!testMode) t.set(identityRef, { claim_id: ctx.claimId, created_at: FieldValue.serverTimestamp() })
      return claimedResponse(record)
    })

    if (result && result.state === 'retry_now') {
      configCache = { at: 0, config: null }
      return { state: 'busy' }
    }
    if (result) return result
  }
  return { state: 'busy' }
}

// ---------------------------------------------------------------------------------------------------

const handle = (fn) => async (req, res, next) => {
  try {
    const ctx = await resolve(req, res)
    if (!ctx) return next() // Express's own 404, identical to any unknown route (so no headers set before this)
    const result = await fn(ctx, req)
    if (result.state === 'closed') return next()
    res.set('Cache-Control', 'no-store')
    res.status(result.state === 'busy' ? 503 : 200).json(result)
  } catch (err) {
    console.error('[LIGHTHOUSE KEY]', err)
    res.set('Cache-Control', 'no-store')
    res.status(503).json({ state: 'error' })
  }
}

// Unauthenticated: lets the page decide on its 404 before anyone logs in.
router.post('/open', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  const config = await getConfig()
  res.json({ open: config.open })
})

router.post(
  '/',
  handle((ctx) => status(ctx))
)

router.post(
  '/claim',
  handle(async (ctx, req) => {
    if (req.body.terms_version !== TERMS_VERSION) {
      const s = await status(ctx)
      return s.state === 'eligible' ? { ...s, state: 'terms_changed' } : s
    }
    return claim(ctx, req.body.email)
  })
)

module.exports = router
