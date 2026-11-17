'use strict'
/*
 * Proves guard.js blocks writes. Run from the app directory (normally BASELINE), with the guard preloaded:
 *
 *   cd <baseline> && PARITY_WRITE_LOG=<file> node -r <abs>/guard.js <abs>/guard.selftest.js
 *
 * Calls every write path against a throwaway doc, asserts the log recorded it, then does a REAL read and asserts
 * the document does not exist in production. Exits non-zero on any failure.
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const assert = require('assert')
const { createRequire } = require('module')

const cwdRequire = createRequire(path.join(process.cwd(), 'x.js'))
cwdRequire('dotenv').config()
const admin = cwdRequire('firebase-admin')
const db = cwdRequire(path.join(process.cwd(), 'firestore.js'))()
const FieldValue = admin.firestore.FieldValue
const LOG = process.env.PARITY_WRITE_LOG

const lines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
let pass = 0
const check = (name, fn) =>
  Promise.resolve(fn()).then(
    () => { pass++; console.log('  ok   ' + name) },
    (e) => { console.log('  FAIL ' + name + ': ' + e.message); process.exitCode = 1 }
  )

async function main() {
  fs.writeFileSync(LOG, '')
  const ref = db.collection('parity_guard_selftest').doc('x')
  const ref2 = db.collection('parity_guard_selftest').doc('y')
  const log = () => lines()

  await check('doc.set (merge) recorded with sentinels serialised', async () => {
    const r = await ref.set({ a: 1, n: FieldValue.increment(2), at: FieldValue.serverTimestamp(), d: new Date(), u: FieldValue.arrayUnion('p', 'q'), x: FieldValue.delete() }, { merge: true })
    assert(r.writeTime)
    const e = log().find((l) => l.op === 'set')
    assert.deepStrictEqual(e.path, 'parity_guard_selftest/x')
    assert.deepStrictEqual(e.options, { merge: true })
    assert.deepStrictEqual(e.data.n, { $fieldValue: 'increment', operand: 2 })
    assert.deepStrictEqual(e.data.at, { $fieldValue: 'serverTimestamp' })
    assert.deepStrictEqual(e.data.d, { $time: true })
    assert.deepStrictEqual(e.data.u, { $fieldValue: 'arrayUnion', elements: ['p', 'q'] })
    assert.deepStrictEqual(e.data.x, { $fieldValue: 'delete' })
  })
  await check('doc.update recorded', async () => {
    await ref.update({ download_count: FieldValue.increment(1) })
    assert(log().some((l) => l.op === 'update' && l.data.download_count.$fieldValue === 'increment'))
  })
  await check('doc.create recorded', async () => {
    await ref.create({ c: 1 })
    assert(log().some((l) => l.op === 'create'))
  })
  await check('doc.delete recorded', async () => {
    await ref.delete()
    assert(log().some((l) => l.op === 'delete' && l.path === 'parity_guard_selftest/x'))
  })
  await check('collection.add recorded and returns a usable ref', async () => {
    const r = await db.collection('parity_guard_selftest').add({ t: new Date() })
    assert(/^guard_\d+$/.test(r.id), 'id ' + r.id)
    assert(log().some((l) => l.op === 'add' && l.path === 'parity_guard_selftest' && l.data.t.$time))
  })
  await check('WriteBatch queued and recorded only on commit', async () => {
    const b = db.batch()
    b.set(ref, { b: 1 }).update(ref2, { b: 2 }).delete(ref)
    assert(!log().some((l) => l.op.startsWith('batch.')), 'recorded before commit')
    await b.commit()
    assert.deepStrictEqual(log().filter((l) => l.op.startsWith('batch.')).map((l) => l.op), ['batch.set', 'batch.update', 'batch.delete'])
  })
  await check('runTransaction: real reads, recorded writes', async () => {
    const out = await db.runTransaction(async (t) => {
      const [d1] = await t.getAll(ref, ref2)
      const d2 = await t.get(ref)
      t.set(ref, { t: 1 }).update(ref2, { t: 2 })
      t.create(ref, { t: 3 })
      return { exists: d1.exists || d2.exists }
    })
    assert.strictEqual(out.exists, false)
    assert.deepStrictEqual(log().filter((l) => l.op.startsWith('txn.')).map((l) => l.op), ['txn.set', 'txn.update', 'txn.create'])
  })
  await check('BulkWriter recorded', async () => {
    const bw = db.bulkWriter()
    await bw.set(ref, { w: 1 })
    await bw.flush()
    await bw.close()
    assert(log().some((l) => l.op === 'bulk.set'))
  })
  await check('low-level commit RPC is refused (defence in depth)', async () => {
    let threw = false
    try {
      await db.request('commit', { database: db.formattedName, writes: [] }, 'selftest')
    } catch (e) {
      threw = /parity-guard/.test(e.message)
    }
    assert(threw)
  })
  await check('POST to a webhook host is recorded, not sent, and answered 200 {} (global fetch)', async () => {
    const r = await fetch('https://discord.com/api/webhooks/0/selftest', { method: 'POST', body: '{}' })
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual(await r.json(), {})
    assert(log().some((l) => l.op === 'http' && l.method === 'POST' && l.url.includes('discord.com')))
  })
  await check('POST via https.request (hookcord-style) is recorded and answered', async () => {
    const https = require('https')
    const body = await new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'api.cloudflare.com', path: '/client/v4/zones/x/purge_cache', method: 'POST' }, (res) => {
        let s = ''
        res.on('data', (c) => (s += c)).on('end', () => resolve(s))
      })
      req.on('error', reject)
      req.end('{"purge_everything":true}')
    })
    assert.strictEqual(body, '{}')
    assert(log().some((l) => l.op === 'http' && l.url.includes('purge_cache')))
  })
  await check('POST via node-fetch is recorded and answered', async () => {
    const nf = cwdRequire('node-fetch')
    const r = await nf('https://api.patreon.com/x', { method: 'POST', body: 'x' })
    assert.strictEqual(r.status, 200)
    assert(log().some((l) => l.op === 'http' && l.url.includes('patreon.com')))
  })
  await check('GET passes through to the network', async () => {
    const srv = http.createServer((q, s) => s.end('real')).listen(0, '127.0.0.1')
    await new Promise((r) => srv.once('listening', r))
    const r = await fetch('http://127.0.0.1:' + srv.address().port + '/')
    assert.strictEqual(await r.text(), 'real')
    srv.close()
  })
  await check('PUT/DELETE to anywhere are blocked', async () => {
    const before = log().length
    await fetch('http://127.0.0.1:1/', { method: 'DELETE' })
    assert.strictEqual(log().length, before + 1)
  })

  // The decisive check: nothing reached production.
  await check('REAL READ: parity_guard_selftest/x and /y do not exist in production', async () => {
    const [a, b] = await db.getAll(ref, ref2)
    assert.strictEqual(a.exists, false, 'x exists!')
    assert.strictEqual(b.exists, false, 'y exists!')
    const snap = await db.collection('parity_guard_selftest').limit(5).get()
    assert.strictEqual(snap.size, 0, 'collection is not empty!')
  })
  console.log(`\n${pass} checks passed; ${log().length} records in ${LOG}`)
}

main().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1) })
