'use strict'
/*
 * Parity write guard. Load with:   node -r <abs path>/guard.js app.js     (from the app's own directory)
 *
 * Makes it impossible for a parity run to change production:
 *   1. Every Firestore write is intercepted at the SDK prototypes and recorded instead of sent. As a second
 *      line of defence the low-level Firestore.request() refuses the write RPCs (commit, batchWrite,
 *      beginTransaction, rollback), so a write path this file does not know about fails loudly instead of landing.
 *   2. Outbound mutating HTTP (fetch, http.request, https.request) is recorded and answered with a fake 200,
 *      except a short allow-list of read-only POSTs (see ALLOWED_POST).
 *
 * Recorded events are JSON lines appended to the file named by PARITY_WRITE_LOG:
 *   {op, path, data, options}  for Firestore writes     {op:"http", method, url}  for blocked HTTP
 *
 * If it cannot prove it patched the Firestore SDK it THROWS, so the app never starts unguarded.
 * Only built-ins are used; no dependencies.
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const { Readable, Writable } = require('stream')

const LOG = process.env.PARITY_WRITE_LOG
if (!LOG) throw new Error('[parity-guard] PARITY_WRITE_LOG is not set; refusing to start without a place to record writes')
fs.mkdirSync(path.dirname(path.resolve(LOG)), { recursive: true })

let addCounter = 0
const record = (entry) => fs.appendFileSync(LOG, JSON.stringify(entry) + '\n')

// ------------------------------------------------------------------------------------------------ serialisation

const isTimestampLike = (v) =>
  v instanceof Date || (v && typeof v === 'object' && v.constructor && v.constructor.name === 'Timestamp')

// FieldValue sentinels are classes named <Something>Transform in @google-cloud/firestore.
const SENTINELS = {
  NumericIncrementTransform: (v) => ({ $fieldValue: 'increment', operand: ser(v.operand) }),
  ArrayUnionTransform: (v) => ({ $fieldValue: 'arrayUnion', elements: ser(v.elements) }),
  ArrayRemoveTransform: (v) => ({ $fieldValue: 'arrayRemove', elements: ser(v.elements) }),
  ServerTimestampTransform: () => ({ $fieldValue: 'serverTimestamp' }),
  DeleteTransform: () => ({ $fieldValue: 'delete' }),
}

function ser(v) {
  if (v === undefined) return { $undefined: true }
  if (v === null || typeof v !== 'object') return v
  if (isTimestampLike(v)) return { $time: true }
  if (Array.isArray(v)) return v.map(ser)
  const name = v.constructor && v.constructor.name
  if (SENTINELS[name]) return SENTINELS[name](v)
  if (name && /Transform$/.test(name)) return { $fieldValue: name.replace(/Transform$/, ''), raw: JSON.parse(JSON.stringify(v)) }
  if (name === 'DocumentReference') return { $ref: v.path }
  if (name === 'GeoPoint') return { $geo: [v.latitude, v.longitude] }
  if (Buffer.isBuffer(v)) return { $bytes: v.length }
  const out = {}
  for (const k of Object.keys(v)) out[k] = ser(v[k])
  return out
}

// update(field, value, field, value, ...) form is legal; fold it into an object so records stay comparable.
const updateData = (args) => {
  if (args.length && typeof args[0] === 'string') {
    const o = {}
    for (let i = 0; i + 1 < args.length; i += 2) o[String(args[i])] = ser(args[i + 1])
    if (args.length % 2) o.$precondition = ser(args[args.length - 1])
    return o
  }
  return ser(args[0])
}

// ------------------------------------------------------------------------------------------------ firestore patching

function locateFirestoreModules() {
  const cwd = process.cwd()
  let adminPath
  try {
    adminPath = require.resolve('firebase-admin', { paths: [cwd] })
  } catch (e) {
    throw new Error('[parity-guard] cannot resolve firebase-admin from ' + cwd + ': ' + e.message)
  }
  const found = new Map() // realpath -> resolved path
  const add = (p) => found.set(fs.realpathSync(p), p)
  add(require.resolve('@google-cloud/firestore', { paths: [path.dirname(adminPath)] }))
  try {
    add(require.resolve('@google-cloud/firestore', { paths: [cwd] }))
  } catch (e) {
    /* no top-level copy */
  }
  return { adminPath, modules: [...found.values()] }
}

function patchModule(modPath) {
  const F = require(modPath)
  const fakeResult = () => ({ writeTime: F.Timestamp.now(), isEqual: () => false })
  const patched = []

  // --- DocumentReference
  const DR = F.DocumentReference && F.DocumentReference.prototype
  if (!DR) throw new Error('[parity-guard] DocumentReference missing from ' + modPath)
  const docWrite = (name) => {
    if (typeof DR[name] !== 'function') return
    DR[name] = function (...args) {
      const entry = { op: name, path: this.path }
      if (name === 'update') entry.data = updateData(args)
      else if (name === 'delete') entry.options = args.length ? ser(args[0]) : null
      else {
        entry.data = ser(args[0])
        entry.options = args.length > 1 ? ser(args[1]) : null
      }
      record(entry)
      return Promise.resolve(fakeResult())
    }
    patched.push('DocumentReference.' + name)
  }
  ;['set', 'update', 'create', 'delete'].forEach(docWrite)

  // --- CollectionReference.add : returns a real (offline) DocumentReference with a fake id.
  const CR = F.CollectionReference && F.CollectionReference.prototype
  if (CR && typeof CR.add === 'function') {
    CR.add = function (data) {
      const id = 'guard_' + ++addCounter
      const ref = this.doc(id)
      record({ op: 'add', path: this.path, data: ser(data), options: null, id })
      return Promise.resolve(ref)
    }
    patched.push('CollectionReference.add')
  }

  // --- WriteBatch : queue on the batch, record on commit.
  const WB = F.WriteBatch && F.WriteBatch.prototype
  if (WB) {
    for (const name of ['set', 'update', 'create', 'delete']) {
      if (typeof WB[name] !== 'function') continue
      WB[name] = function (ref, ...args) {
        this.__guardOps = this.__guardOps || []
        const entry = { op: 'batch.' + name, path: ref.path }
        if (name === 'update') entry.data = updateData(args)
        else if (name === 'delete') entry.options = args.length ? ser(args[0]) : null
        else {
          entry.data = ser(args[0])
          entry.options = args.length > 1 ? ser(args[1]) : null
        }
        this.__guardOps.push(entry)
        return this
      }
      patched.push('WriteBatch.' + name)
    }
    WB.commit = function () {
      const ops = this.__guardOps || []
      for (const e of ops) record(e)
      this.__guardOps = []
      return Promise.resolve(ops.map(fakeResult))
    }
    patched.push('WriteBatch.commit')
  }

  // --- BulkWriter : record immediately, resolve; flush/close are no-ops.
  const BW = F.BulkWriter && F.BulkWriter.prototype
  if (BW) {
    for (const name of ['set', 'update', 'create', 'delete']) {
      if (typeof BW[name] !== 'function') continue
      BW[name] = function (ref, ...args) {
        const entry = { op: 'bulk.' + name, path: ref.path }
        if (name === 'update') entry.data = updateData(args)
        else if (name === 'delete') entry.options = args.length ? ser(args[0]) : null
        else {
          entry.data = ser(args[0])
          entry.options = args.length > 1 ? ser(args[1]) : null
        }
        record(entry)
        return Promise.resolve(fakeResult())
      }
      patched.push('BulkWriter.' + name)
    }
    for (const name of ['flush', 'close']) {
      if (typeof BW[name] === 'function') BW[name] = () => Promise.resolve()
    }
  }

  // --- Firestore: runTransaction with a recording proxy, recursiveDelete blocked, low-level RPCs refused.
  const FS = F.Firestore && F.Firestore.prototype
  if (FS) {
    if (typeof FS.runTransaction === 'function') {
      FS.runTransaction = function (updateFunction) {
        const db = this
        const t = {
          get: (target, ...rest) => (target && typeof target.get === 'function' ? target.get() : db.getAll(target, ...rest)),
          getAll: (...refs) => db.getAll(...refs),
        }
        for (const name of ['set', 'update', 'create', 'delete']) {
          t[name] = (ref, ...args) => {
            const entry = { op: 'txn.' + name, path: ref.path }
            if (name === 'update') entry.data = updateData(args)
            else if (name === 'delete') entry.options = args.length ? ser(args[0]) : null
            else {
              entry.data = ser(args[0])
              entry.options = args.length > 1 ? ser(args[1]) : null
            }
            record(entry)
            return t
          }
        }
        return Promise.resolve().then(() => updateFunction(t))
      }
      patched.push('Firestore.runTransaction')
    }
    if (typeof FS.recursiveDelete === 'function') {
      FS.recursiveDelete = function (ref) {
        record({ op: 'recursiveDelete', path: ref && ref.path })
        return Promise.resolve()
      }
      patched.push('Firestore.recursiveDelete')
    }
    if (typeof FS.request === 'function') {
      const realRequest = FS.request
      const BLOCKED = new Set(['commit', 'batchWrite', 'beginTransaction', 'rollback'])
      FS.request = function (methodName, ...rest) {
        if (BLOCKED.has(methodName)) {
          record({ op: 'rpc_blocked', path: methodName, data: null, options: null })
          return Promise.reject(new Error('[parity-guard] blocked Firestore RPC: ' + methodName))
        }
        return realRequest.call(this, methodName, ...rest)
      }
      patched.push('Firestore.request(write RPCs refused)')
    }
  }
  return patched
}

const { adminPath, modules } = locateFirestoreModules()
const summary = []
for (const m of modules) summary.push(m + ' [' + patchModule(m).length + ' patches]')
if (!summary.length) throw new Error('[parity-guard] no @google-cloud/firestore module patched')
console.error('[parity-guard] firebase-admin=' + adminPath + ' patched Firestore modules: ' + summary.join(' ; ') + ' log=' + LOG)

// ------------------------------------------------------------------------------------------------ http blocking

const ALLOWED_POST = (host, p) =>
  (host === 'api.cloudflare.com' && (p.includes('/graphql') || p.includes('/ai/run/'))) ||
  // Google service-account token exchange: needed for Firestore auth, does not mutate anything.
  host === 'oauth2.googleapis.com' ||
  (host === 'www.googleapis.com' && p.startsWith('/oauth2/'))

class FakeRequest extends Writable {
  constructor(cb) {
    super({ write: (c, e, n) => n() })
    this.__cb = cb
    this.headers = {}
    this.on('finish', () => setImmediate(() => this.__respond()))
  }
  setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this }
  getHeader(k) { return this.headers[String(k).toLowerCase()] }
  removeHeader(k) { delete this.headers[String(k).toLowerCase()] }
  getHeaders() { return this.headers }
  setTimeout() { return this }
  setNoDelay() {}
  setSocketKeepAlive() {}
  flushHeaders() {}
  abort() { this.destroy() }
  __respond() {
    const res = Readable.from([Buffer.from('{}')])
    res.statusCode = 200
    res.statusMessage = 'OK'
    res.headers = { 'content-type': 'application/json', 'content-length': '2' }
    res.rawHeaders = ['content-type', 'application/json', 'content-length', '2']
    res.httpVersion = '1.1'
    if (this.__cb) this.__cb(res)
    this.emit('response', res)
  }
}

// Normalise the (url|options, options, cb) overloads into {method, url}.
function describe(defaultProto, args) {
  let [a, b] = args
  let opts = {}
  if (typeof a === 'string' || a instanceof URL) {
    const u = new URL(String(a))
    opts = { protocol: u.protocol, hostname: u.hostname, port: u.port, path: u.pathname + u.search }
    if (b && typeof b === 'object') opts = { ...opts, ...b }
  } else if (a && typeof a === 'object') {
    opts = a
  }
  const proto = opts.protocol || defaultProto
  const host = String(opts.hostname || opts.host || 'localhost').replace(/:\d+$/, '')
  const p = opts.path || '/'
  return { method: String(opts.method || 'GET').toUpperCase(), host, path: p, url: `${proto}//${host}${opts.port ? ':' + opts.port : ''}${p}` }
}

function wrapRequest(mod, defaultProto) {
  const real = mod.request
  mod.request = function (...args) {
    const d = describe(defaultProto, args)
    if (d.method === 'GET' || d.method === 'HEAD' || (d.method === 'POST' && ALLOWED_POST(d.host, d.path))) {
      return real.apply(this, args)
    }
    record({ op: 'http', method: d.method, url: d.url })
    const cb = args.find((x) => typeof x === 'function')
    return new FakeRequest(cb)
  }
  const realGet = mod.get
  // get() is GET-only, and uses the module-internal request, so it needs no wrapping.
  mod.get = realGet
}
wrapRequest(http, 'http:')
wrapRequest(https, 'https:')

if (typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch
  globalThis.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
    const u = new URL(url)
    if (method === 'GET' || method === 'HEAD' || (method === 'POST' && ALLOWED_POST(u.hostname, u.pathname + u.search))) {
      return realFetch.apply(this, arguments)
    }
    record({ op: 'http', method, url })
    return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
  }
}
