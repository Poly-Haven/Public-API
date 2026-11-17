import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it, mock } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { Asset } from '../../types/firestore.ts'
import { checkKeyLimit, resetKeyLimits } from '../../utils/keyRateLimit.ts'
import {
  EXISTING_PATRON_KEY,
  FAKE,
  MASTER,
  NON_EA_KEY,
  REVOKED_KEY,
  bearer,
  getApp,
  SUPERHIVE_KEY,
  SUPERHIVE_UID,
  MIXED_KEY,
  writeLogSize,
  writesSince,
} from './fixtures.ts'

// The keyed endpoints (/v2/key, /v2/ea/*, /v2/extensions) and key minting. Every key here is a fixture made up
// per run (test/v2/fixtures.ts), so nothing depends on which keys or early-access assets production holds today.

type Json = { message?: string; error?: string; data?: unknown; meta?: unknown; [key: string]: unknown }
type FilesBySlug = Record<string, Record<string, unknown>>
type Minted = { key: string; reused: boolean; patron_uid?: string; superhive_uid?: number }
const dataOf = <T>(body: Json) => body.data as T

let app: FastifyInstance
const superhive = SUPERHIVE_KEY
// Fixtures (test/v2/fixtures.ts): a scheduled early-access asset and a released one, each with a files doc.
const earlyAccess = FAKE.ea1
const released = FAKE.released
let assets: Record<string, Asset>

const call = async (method: 'GET' | 'POST', url: string, headers: Record<string, string> = {}, payload?: object) => {
  const res = await app.inject({ method, url, headers, payload })
  const body: Json = res.headers['content-type']?.toString().includes('json') ? res.json() : {}
  return { res, body, cache: res.headers['cache-control'] as string }
}

before(async () => {
  app = await getApp()
  assets = dataOf<Record<string, Asset>>((await call('GET', '/v2/assets')).body)
})

beforeEach(() => resetKeyLimits())

describe('key validation, on every keyed endpoint', () => {
  const urls = ['/v2/key', '/v2/ea/files', `/v2/ea/files/${FAKE.released}`]

  it('refuses a missing, malformed, unknown, revoked key with a private, uncached 403 and no key document', async () => {
    const strangers = ['', 'garbage', 'f'.repeat(64)] // none of these is a key
    for (const url of urls) {
      for (const key of strangers) {
        const { res, body, cache } = await call('GET', url, key ? bearer(key) : {})
        assert.equal(res.statusCode, 403, url)
        assert.equal(cache, 'private, no-store')
        assert.equal(body.error, '403 Forbidden')
        assert.ok(!('meta' in body))
      }
      const revoked = await call('GET', url, bearer(REVOKED_KEY))
      assert.equal(revoked.res.statusCode, 403)
      assert.equal(revoked.body.message, 'API key is not active')
      assert.equal(revoked.cache, 'private, no-store')
      assert.ok(!('meta' in revoked.body))
    }
  })
})

describe('GET /v2/key', () => {
  it('describes the key without returning it', async () => {
    const ea = await call('GET', '/v2/key', bearer(superhive))
    assert.equal(ea.res.statusCode, 200)
    assert.equal(ea.cache, 'private, no-store')
    assert.deepEqual(ea.body.data, { valid: true, early_access: true, kind: 'superhive' })
    assert.ok(!ea.res.body.includes(superhive), 'the key is not echoed')
    assert.ok(!('meta' in ea.body))

    const plain = await call('GET', '/v2/key', bearer(NON_EA_KEY))
    assert.deepEqual(plain.body.data, { valid: true, early_access: false, kind: 'patron' })
    assert.equal(plain.cache, 'private, no-store')
  })
})

describe('GET /v2/ea/files/:id', () => {
  it('gives early-access files only to a key with early access', async () => {
    const withEa = await call('GET', `/v2/ea/files/${earlyAccess}`, bearer(superhive))
    assert.equal(withEa.res.statusCode, 200)
    assert.equal(withEa.cache, 'private, no-store')
    assert.equal(withEa.body.message, 'OK')
    assert.ok(Object.keys(dataOf<object>(withEa.body)).length > 0)

    const without = await call('GET', `/v2/ea/files/${earlyAccess}`, bearer(NON_EA_KEY))
    assert.equal(without.res.statusCode, 403)
    assert.equal(without.body.message, 'This key does not include early access')
    assert.equal(without.cache, 'private, no-store')
    assert.equal((await call('GET', `/v2/ea/files/${FAKE.soon}`, bearer(NON_EA_KEY))).res.statusCode, 403)
    assert.equal((await call('GET', `/v2/ea/files/${FAKE.soon}`, bearer(superhive))).res.statusCode, 200)
  })

  it('gives a released asset to any valid key', async () => {
    for (const key of [NON_EA_KEY, superhive]) {
      const { res, body, cache } = await call('GET', `/v2/ea/files/${released}`, bearer(key))
      assert.equal(res.statusCode, 200)
      assert.equal(cache, 'private, no-store')
      assert.ok(Object.keys(dataOf<object>(body)).length > 0)
    }
  })

  it('404s staging and unknown ids, 400s bad ones, all private', async () => {
    for (const [id, status] of [
      [FAKE.staging, 404],
      ['zz_test_does_not_exist', 404],
      ['bad!id', 400],
    ] as const) {
      const { res, cache } = await call('GET', `/v2/ea/files/${id}`, bearer(superhive))
      assert.equal(res.statusCode, status, id)
      assert.equal(cache, 'private, no-store')
    }
  })
})

describe('GET /v2/ea/files', () => {
  it('needs early access', async () => {
    const { res, body, cache } = await call('GET', '/v2/ea/files', bearer(NON_EA_KEY))
    assert.equal(res.statusCode, 403)
    assert.equal(body.message, 'This key does not include early access')
    assert.equal(cache, 'private, no-store')
  })

  it('returns the files of early-access assets and nothing else', async () => {
    const { res, body, cache } = await call('GET', '/v2/ea/files', bearer(superhive))
    assert.equal(res.statusCode, 200)
    assert.equal(cache, 'private, no-store')
    const data = dataOf<FilesBySlug>(body)
    const slugs = Object.keys(data)
    assert.ok(slugs.length > 0)
    for (const slug of slugs) {
      assert.ok(assets[slug].date_published > Date.now() / 1000, `${slug} is early access`)
      assert.ok(Object.keys(data[slug]).length > 0)
    }
    assert.ok(FAKE.soon in data)
    assert.ok(!(FAKE.released in data) && !(FAKE.staging in data))
    assert.ok(!(released in data))
    // The same files doc as the per-asset endpoint.
    const one = await call('GET', `/v2/ea/files/${earlyAccess}`, bearer(superhive))
    if (earlyAccess in data) assert.deepEqual(data[earlyAccess], one.body.data)
  })

  it('narrows by type', async () => {
    const { res, body } = await call('GET', '/v2/ea/files?type=models', bearer(superhive))
    assert.equal(res.statusCode, 200)
    for (const slug of Object.keys(dataOf<object>(body))) assert.equal(assets[slug].type, 2)
    const bad = await call('GET', '/v2/ea/files?type=nonsense', bearer(superhive))
    assert.equal(bad.res.statusCode, 400)
    assert.equal(bad.cache, 'private, no-store')
  })
})

describe('GET /v2/extensions', () => {
  it('needs any valid key, early access or not, and is never cached', async () => {
    for (const url of ['/v2/extensions', '/v2/extensions?blender_version=99.0']) {
      for (const key of [superhive, NON_EA_KEY]) {
        const { res, body, cache } = await call('GET', url, bearer(key))
        assert.equal(res.statusCode, 200, url)
        assert.equal(cache, 'private, no-store')
        assert.equal(body.message, 'OK')
        assert.ok(Array.isArray(body.data) && !('meta' in body))
      }
    }
  })

  it('refuses a missing, unknown or revoked key with a private 403', async () => {
    for (const headers of [{}, bearer('f'.repeat(64)), bearer(REVOKED_KEY)]) {
      const { res, cache } = await call('GET', '/v2/extensions', headers)
      assert.equal(res.statusCode, 403)
      assert.equal(cache, 'private, no-store')
    }
  })
})

describe('per-key rate limiting', () => {
  const fakeReq = (ip: string) => ({ headers: { 'cf-connecting-ip': ip }, ip }) as never

  it('only warns while not enforcing: the 301st request in a burst goes through', async () => {
    const warn = mock.method(console, 'warn', () => {})
    try {
      let refused = 0
      for (let i = 0; i < 305; i++) if (!checkKeyLimit(fakeReq('1.1.1.1'), NON_EA_KEY, 'reftest01').allowed) refused++
      assert.equal(refused, 0)
      const lines = warn.mock.calls.map((c) => String(c.arguments[0]))
      assert.deepEqual(lines, ['[KEY RATE] reftest01 over limit'])
    } finally {
      warn.mock.restore()
    }
  })

  it('refuses with a Retry-After when enforcing', async () => {
    process.env.KEY_RATE_LIMIT_ENFORCE = '1'
    try {
      // The Superhive key: validating it is a cache hit, where a patron key costs a Firestore read per request.
      let last = await call('GET', '/v2/key', bearer(superhive))
      for (let i = 0; i < 305 && last.res.statusCode === 200; i++)
        last = await call('GET', '/v2/key', bearer(superhive))
      assert.equal(last.res.statusCode, 429)
      assert.ok(Number(last.res.headers['retry-after']) >= 1)
      assert.equal(last.cache, 'private, no-store')
    } finally {
      delete process.env.KEY_RATE_LIMIT_ENFORCE
    }
  })

  it('warns as a key reaches 5, 10, 20 and 50 distinct IPs, by ref and never by the key', async () => {
    const warn = mock.method(console, 'warn', () => {})
    try {
      for (let i = 1; i <= 60; i++) {
        checkKeyLimit(fakeReq(`10.0.0.${i}`), NON_EA_KEY, 'reftest02')
        checkKeyLimit(fakeReq(`10.0.0.${i}`), NON_EA_KEY, 'reftest02') // a repeat IP is not a new one
      }
      const lines = warn.mock.calls.map((c) => String(c.arguments[0]))
      assert.deepEqual(
        lines,
        [5, 10, 20, 50].map((n) => `[KEY IPS] reftest02 reached ${n} distinct IPs today`)
      )
      checkKeyLimit(fakeReq('9.9.9.9'), REVOKED_KEY, undefined)
      for (let i = 1; i <= 5; i++) checkKeyLimit(fakeReq(`9.9.9.${i}`), REVOKED_KEY, undefined)
      const last = String(warn.mock.calls.at(-1)!.arguments[0])
      assert.ok(last.includes(REVOKED_KEY.slice(0, 8)) && !last.includes(REVOKED_KEY))
    } finally {
      warn.mock.restore()
    }
  })
})

describe('POST /v2/create_key', () => {
  const post = (body: object, master = MASTER) => call('POST', '/v2/create_key', bearer(master), body)

  it('keeps its master-secret auth', async () => {
    const { res, body, cache } = await post({ patron_uid: FAKE.patron }, 'wrong')
    assert.equal(res.statusCode, 403)
    assert.equal(body.message, 'Incorrect key')
    assert.equal(cache, 'private, no-store')
    assert.equal((await call('POST', '/v2/create_key', {}, {})).res.statusCode, 403)
  })

  it('mints a key for a patron with none, in a transaction that also writes the patron lock document', async () => {
    const before = writeLogSize()
    const { res, body } = await post({ patron_uid: FAKE.patron })
    assert.equal(res.statusCode, 200)
    const minted = dataOf<Minted>(body)
    assert.match(minted.key, /^[0-9a-f]{64}$/)
    assert.equal(minted.reused, false)
    assert.equal(minted.patron_uid, FAKE.patron)
    const writes = writesSince(before)
    assert.deepEqual(
      writes.map((w) => w.op),
      ['txn.create', 'txn.set']
    )
    assert.ok(writes[0].path === `api_keys/${minted.key}`)
    assert.equal(writes[0].data!.status, 'active')
    assert.equal(writes[1].path, `api_key_patrons/${FAKE.patron}`)
    assert.ok(writes[1].data!.key === minted.key)
    assert.match(String(writes[1].data!.updated_at), /^\d{4}-\d\d-\d\dT/)
  })

  it('returns the existing active key instead of minting another', async () => {
    const before = writeLogSize()
    const { res, body } = await post({ patron_uid: FAKE.patronWithKey })
    assert.equal(res.statusCode, 200)
    assert.ok(dataOf<Minted>(body).key === EXISTING_PATRON_KEY)
    assert.equal(dataOf<Minted>(body).reused, true)
    assert.equal(writesSince(before).length, 0)
  })

  it('rotates: a new key, the old one revoked', async () => {
    const before = writeLogSize()
    const { res, body } = await post({ patron_uid: FAKE.patronWithKey, rotate: true })
    assert.equal(res.statusCode, 200)
    const minted = dataOf<Minted>(body)
    assert.ok(minted.key !== EXISTING_PATRON_KEY && /^[0-9a-f]{64}$/.test(minted.key))
    assert.equal(minted.reused, false)
    const writes = writesSince(before)
    assert.deepEqual(
      writes.map((w) => w.op),
      ['txn.create', 'txn.set', 'txn.update']
    )
    assert.ok(writes[0].path === `api_keys/${minted.key}`)
    assert.equal(writes[1].path, `api_key_patrons/${FAKE.patronWithKey}`)
    assert.ok(writes[2].path === `api_keys/${EXISTING_PATRON_KEY}`)
    assert.equal(writes[2].data!.status, 'revoked')
    assert.match(String(writes[2].data!.revoked_at), /^\d{4}-\d\d-\d\dT/)
  })

  it('leaves a key that also carries a superhive_uid alone: it is neither reused nor revoked', async () => {
    for (const rotate of [false, true]) {
      const before = writeLogSize()
      const { res, body } = await post({ patron_uid: FAKE.patronWithMixedKey, rotate })
      assert.equal(res.statusCode, 200)
      const minted = dataOf<Minted>(body)
      assert.ok(minted.key !== MIXED_KEY && minted.reused === false)
      const writes = writesSince(before)
      assert.deepEqual(
        writes.map((w) => w.op),
        ['txn.create', 'txn.set']
      )
      assert.ok(!writes.some((w) => w.path === `api_keys/${MIXED_KEY}`))
    }
  })

  it('still mints Superhive keys unconditionally', async () => {
    const before = writeLogSize()
    const { res, body } = await post({ superhive_uid: 424242 })
    assert.equal(res.statusCode, 200)
    assert.equal(dataOf<Minted>(body).superhive_uid, 424242)
    assert.equal(SUPERHIVE_UID, 424242)
    const writes = writesSince(before)
    assert.deepEqual(
      writes.map((w) => w.op),
      ['set']
    )
  })

  it('rejects a patron_uid that is not an id', async () => {
    assert.equal((await post({ patron_uid: { $ne: 1 } })).res.statusCode, 400)
  })
})

after(() => {
  delete process.env.KEY_RATE_LIMIT_ENFORCE
})
