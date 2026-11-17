'use strict'
/*
 * Looks up the few live values the replay needs but the nginx logs cannot supply, and writes them to a
 * context file OUTSIDE the repo. Reads only (~110 documents). Run it through the guard like everything else:
 *
 *   cd <baseline> && PARITY_WRITE_LOG=<log> node -r <abs>/guard.js <abs>/find-context.js <out context.json>
 *
 * Output keys (never printed): key_ea (an active API key with superhive_uid), key_plain (an active key with only a
 * patron_uid), patron_uuid (an existing patron doc id). Any may be null; dependent cases are then skipped.
 */
const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')

const out = process.argv[2]
if (!out) throw new Error('usage: find-context.js <out.json>')
const cwdRequire = createRequire(path.join(process.cwd(), 'x.js'))
cwdRequire('dotenv').config()
const db = cwdRequire(path.join(process.cwd(), 'firestore.js'))()

;(async () => {
  const ctx = { key_ea: null, key_plain: null, patron_uuid: null }
  const keys = await db.collection('api_keys').limit(100).get()
  keys.forEach((d) => {
    const k = d.data()
    if (k.status !== 'active') return
    if (!ctx.key_ea && k.superhive_uid) ctx.key_ea = d.id
    if (!ctx.key_plain && k.patron_uid && !k.superhive_uid) ctx.key_plain = d.id
  })
  const p = await db.collection('patrons').limit(1).get()
  p.forEach((d) => (ctx.patron_uuid = d.id))
  fs.writeFileSync(out, JSON.stringify(ctx))
  console.log('context written:', Object.fromEntries(Object.entries(ctx).map(([k, v]) => [k, v ? 'found' : 'missing'])))
  process.exit(0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
