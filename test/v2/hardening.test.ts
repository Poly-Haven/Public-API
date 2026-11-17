import assert from 'node:assert/strict'
import { before, beforeEach, describe, it, mock } from 'node:test'
import { DocumentReference } from 'firebase-admin/firestore'
import type { FastifyInstance } from 'fastify'
import type { Asset } from '../../types/firestore.ts'
import cachedFirestore from '../../utils/cachedFirestore.ts'
import { redactUrl } from '../../utils/http.ts'
import { resetKeyLimits } from '../../utils/keyRateLimit.ts'
import { FAKE, NON_EA_KEY, SUPERHIVE_KEY, VAULT, bearer, getApp } from './fixtures.ts'

// Review fixes: the cache-rule escape, failed-key limiting, the negative cache, vault masking before filtering
// and indexing, inherited type names, and log redaction.

type Json = { message?: string; error?: string; data?: unknown; [key: string]: unknown }

let app: FastifyInstance

const get = async (url: string, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: 'GET', url, headers })
  const body: Json = res.headers['content-type']?.toString().includes('json') ? res.json() : {}
  return { res, body, cache: res.headers['cache-control'] as string }
}

before(async () => {
  app = await getApp()
})
beforeEach(() => resetKeyLimits())

describe('case variants of /v2 (the Cloudflare cache rule is case-sensitive)', () => {
  it('404s any path that is /v2 in another casing, uncached, with CORS and the ToS header', async () => {
    for (const url of ['/V2/assets', '/V2', '/V2/ea/files', '/V2/Assets?t=hdris', '/%56%32/assets', '/v%32/assets']) {
      const { res, body, cache } = await get(url)
      assert.equal(res.statusCode, 404, url)
      assert.equal(cache, 'no-store', url)
      assert.equal(body.error, '404 Not Found', url)
      assert.equal(res.headers['access-control-allow-origin'], '*')
      assert.ok(res.headers['terms-of-service'])
    }
    const keyed = await get('/V2/ea/files', bearer(SUPERHIVE_KEY))
    assert.equal(keyed.res.statusCode, 404)
    assert.ok(!('data' in keyed.body))
  })

  it('still serves the lower-case namespace, with any casing below it, and v1 stays case-insensitive', async () => {
    assert.equal((await get('/v2/assets?t=hdris')).res.statusCode, 200)
    assert.equal((await get('/v2/ASSETS?t=hdris')).res.statusCode, 200)
    const lower = await get('/assets?t=hdris')
    const upper = await get('/ASSETS?t=hdris')
    assert.equal(upper.res.statusCode, 200)
    assert.equal(upper.res.body, lower.res.body)
  })
})

describe('failed key validations per client IP', () => {
  const stranger = 'a'.repeat(64) // well formed, not a key
  const fromIp = (ip: string, key = stranger) => get('/v2/key', { ...bearer(key), 'cf-connecting-ip': ip })

  it('refuses the 31st failure from an IP with a private 429 and Retry-After, and never a valid key', async () => {
    const ip = '198.51.100.7'
    for (let i = 0; i < 30; i++) assert.equal((await fromIp(ip)).res.statusCode, 403)
    const limited = await fromIp(ip)
    assert.equal(limited.res.statusCode, 429)
    assert.equal(limited.cache, 'private, no-store')
    assert.ok(Number(limited.res.headers['retry-after']) >= 1)
    // Valid keys are never refused, from the blocked IP or anywhere.
    assert.equal((await fromIp(ip, SUPERHIVE_KEY)).res.statusCode, 200)
    assert.equal((await fromIp(ip, NON_EA_KEY)).res.statusCode, 200)
    // Another client is unaffected.
    assert.equal((await fromIp('198.51.100.8')).res.statusCode, 403)
  })

  it('does not count requests without a key', async () => {
    const ip = '198.51.100.9'
    for (let i = 0; i < 40; i++) assert.equal((await get('/v2/key', { 'cf-connecting-ip': ip })).res.statusCode, 403)
  })
})

describe('negative cache for missing documents', () => {
  it('reads Firestore once per missing id per minute, and forgetMissing / clearCache lift it', async () => {
    const id = `zz_test_missing_${Math.random().toString(36).slice(2)}`
    const doc = () => cachedFirestore().collection('api_keys').doc(id)
    const spy = mock.method(DocumentReference.prototype, 'get')
    try {
      assert.equal((await doc().get()).exists, false)
      assert.equal((await doc().get()).exists, false)
      assert.equal((await doc().get()).exists, false)
      assert.equal(spy.mock.callCount(), 1)

      cachedFirestore.forgetMissing('api_keys', id)
      await doc().get()
      assert.equal(spy.mock.callCount(), 2)

      cachedFirestore.clearCache()
      await doc().get()
      assert.equal(spy.mock.callCount(), 3)
    } finally {
      spy.mock.restore()
    }
  })

  it('cacheOnly never reads Firestore', async () => {
    const spy = mock.method(DocumentReference.prototype, 'get')
    try {
      const snap = await cachedFirestore().collection('api_keys').doc('zz_test_never_read', { cacheOnly: true }).get()
      assert.equal(snap.exists, false)
      assert.equal(spy.mock.callCount(), 0)
    } finally {
      spy.mock.restore()
    }
  })
})

describe('an unannounced vault cannot be confirmed through filtering or counting', () => {
  const legacy = encodeURIComponent(`vault: ${VAULT}`)

  it('the asset is listed, masked, and its legacy vault category matches nothing', async () => {
    const listed = (await get('/v2/assets?t=hdris')).body.data as Record<string, Asset>
    assert.ok(listed[FAKE.vaulted], 'listed like any early-access asset')
    assert.equal(listed[FAKE.vaulted].vault, 'upcoming')
    assert.ok(!listed[FAKE.vaulted].categories.includes(`vault: ${VAULT}`))

    for (const url of [
      `/v2/assets?c=${legacy}`,
      `/v2/assets?categories=${legacy}`,
      `/assets?c=${legacy}&future=true`,
    ]) {
      const { res, body } = await get(url)
      assert.equal(res.statusCode, 200, url)
      const data = ('data' in body ? body.data : body) as Record<string, Asset>
      assert.deepEqual(Object.keys(data), [], url)
    }
    // Several categories, one of them the legacy one.
    const both = await get(`/v2/assets?c=${legacy},hdris`)
    assert.deepEqual(Object.keys(both.body.data as object), [])
  })

  it('category counts neither include the legacy category nor can be narrowed by it', async () => {
    const counts = (await get('/v2/categories/hdris')).body.data as Record<string, number>
    assert.ok(!(`vault: ${VAULT}` in counts))
    assert.ok(counts.all >= 1)
    const narrowed = await get(`/v2/categories/hdris?in=${legacy}`)
    assert.equal(narrowed.res.statusCode, 200)
    assert.deepEqual(narrowed.body.data, {})
    const v1 = await get(`/categories/hdris?in=${legacy}&future=true`)
    assert.deepEqual(v1.body, {})
  })
})

describe('asset types are own keys', () => {
  it('answers 400 for an inherited name on the v2 routes that take a type', async () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      for (const url of [`/v2/assets?t=${name}`, `/v2/assets?type=${name}`, `/v2/search?q=forest&t=${name}`]) {
        const { res, cache } = await get(url)
        assert.equal(res.statusCode, 400, url)
        assert.equal(cache, 'public, max-age=300')
      }
      assert.equal((await get(`/v2/categories/${name}`)).res.statusCode, 400)
    }
    assert.equal((await get('/v2/assets?t=all')).res.statusCode, 200)
    assert.equal((await get('/v2/assets?t=')).res.statusCode, 200)
  })
})

describe('redactUrl', () => {
  it('hides the Superhive webhook secret, in any casing, and leaves everything else', () => {
    assert.equal(redactUrl('/v2/superhive_s3cr3t'), '/v2/superhive_[redacted]')
    assert.equal(redactUrl('/v2/superhive_s3cr3t/?a=1'), '/v2/superhive_[redacted]/?a=1')
    assert.equal(redactUrl('/V2/SuperHive_s3cr3t?x=y'), '/V2/SuperHive_[redacted]?x=y')
    assert.equal(redactUrl('/v2/assets?t=hdris'), '/v2/assets?t=hdris')
    assert.equal(redactUrl('/assets/superhive_x'), '/assets/superhive_x')
  })
})
