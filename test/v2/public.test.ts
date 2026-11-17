import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { Asset } from '../../types/firestore.ts'
import { FAKE, NON_EA_KEY, bearer, getApp, now, readSuperhiveKey } from './fixtures.ts'

// The keyless v2 endpoints, against the real app and production Firestore (reads only: the write guard is
// preloaded by `npm test`). Real assets are found at run time from /v2/assets rather than named here.

type Json = { message?: string; error?: string; data?: unknown; meta?: unknown; [key: string]: unknown }

let app: FastifyInstance
let assets: Record<string, Asset>
let released: string
let earlyAccess: string
let superhiveKey: string | null

const get = async (url: string, headers: Record<string, string> = {}) => {
  const res = await app.inject({ method: 'GET', url, headers })
  const body: Json = res.headers['content-type']?.toString().includes('json') ? res.json() : {}
  return { res, body, cache: res.headers['cache-control'] as string }
}
const maxAge = (cache: string) => Number(/max-age=(\d+)/.exec(cache)?.[1])

before(async () => {
  app = await getApp()
  superhiveKey = await readSuperhiveKey()
  const { body } = await get('/v2/assets')
  assets = body.data as Record<string, Asset>
  const real = Object.entries(assets).filter(([slug]) => !slug.startsWith('zz_test_'))
  released = real.find(([, a]) => a.date_published < now())![0]
  // The soonest real early-access asset that is not a vault one, else any.
  const ea = real
    .filter(([, a]) => a.date_published > now())
    .sort(([, a], [, b]) => a.date_published - b.date_published)
  earlyAccess = ea[0][0]
})

describe('GET /v2/assets', () => {
  it('lists everything non-staging, early access included, wrapped and cacheable', async () => {
    const { res, body, cache } = await get('/v2/assets')
    assert.equal(res.statusCode, 200)
    assert.equal(body.message, 'OK')
    assert.equal(cache, 'public, max-age=3600')
    assert.ok(!('meta' in body))
    assert.ok(!res.headers['x-ph-early-access'])
    assert.ok(assets[earlyAccess].date_published > now(), 'early-access asset is listed')
    assert.ok(assets[FAKE.released] && assets[FAKE.soon], 'fixtures are listed')
    assert.ok(!(FAKE.staging in assets), 'staging is never listed')
    const item = assets[released]
    for (const field of ['old_id', 'reviewers', 'scale', 'staging']) assert.ok(!(field in item), `${field} is stripped`)
    assert.match(item.thumbnail_url as string, /^https:\/\/cdn\.polyhaven\.com\/asset_img\/thumbs\//)
  })

  it('filters by type, and rejects bad input with a cacheable 400', async () => {
    const hdris = await get('/v2/assets?t=hdris')
    assert.equal(hdris.res.statusCode, 200)
    assert.ok(Object.values(hdris.body.data as Record<string, Asset>).every((a) => a.type === 0))
    const bad = await get('/v2/assets?type=nonsense')
    assert.equal(bad.res.statusCode, 400)
    assert.equal(bad.body.error, '400 Bad Request')
    assert.equal(bad.cache, 'public, max-age=300')
    assert.equal((await get('/v2/assets?type[]=hdris')).res.statusCode, 400)
  })
})

describe('GET /v2/info/:id', () => {
  it('serves a released and an early-access asset as items of /v2/assets', async () => {
    for (const slug of [released, earlyAccess]) {
      const { res, body, cache } = await get(`/v2/info/${slug}`)
      assert.equal(res.statusCode, 200)
      assert.equal(cache, 'public, max-age=3600')
      assert.equal(body.message, 'OK')
      assert.deepEqual(body.data, assets[slug])
    }
  })

  it('answers staging and unknown ids with the same cacheable 404, and bad ids with a 400', async () => {
    const staging = await get(`/v2/info/${FAKE.staging}`)
    const missing = await get('/v2/info/zz_test_does_not_exist')
    for (const r of [staging, missing]) {
      assert.equal(r.res.statusCode, 404)
      assert.equal(r.cache, 'public, max-age=300')
    }
    assert.equal(staging.body.error, missing.body.error)
    assert.equal((await get('/v2/info/constructor')).res.statusCode, 404)
    const bad = await get('/v2/info/bad!id')
    assert.equal(bad.res.statusCode, 400)
    assert.equal(bad.cache, 'public, max-age=300')
    assert.equal((await get('/v2/info')).res.statusCode, 400)
  })
})

describe('GET /v2/files/:id', () => {
  it('serves the files of a released asset', async () => {
    const { res, body, cache } = await get(`/v2/files/${released}`)
    assert.equal(res.statusCode, 200)
    assert.equal(cache, 'public, max-age=3600')
    assert.equal(body.message, 'OK')
    assert.ok(body.data && typeof body.data === 'object' && Object.keys(body.data).length > 0)
    assert.ok(!('meta' in body))
  })

  it('refuses an early-access asset with 403, cached no longer than until its release', async () => {
    const real = await get(`/v2/files/${earlyAccess}`)
    assert.equal(real.res.statusCode, 403)
    assert.equal(real.body.error, '403 Forbidden')
    assert.equal(real.body.message, 'Asset is in early access')
    assert.equal(real.body.early_access_until, assets[earlyAccess].date_published)
    const secondsToRelease = assets[earlyAccess].date_published - now()
    assert.ok(maxAge(real.cache) <= Math.max(60, secondsToRelease) && maxAge(real.cache) <= 3600)
    assert.match(real.cache, /^public, max-age=\d+$/)

    // Released in 10 minutes: the cached 403 must expire with the embargo, not an hour later.
    const soon = await get(`/v2/files/${FAKE.soon}`)
    assert.equal(soon.res.statusCode, 403)
    const age = maxAge(soon.cache)
    assert.ok(age >= 60 && age <= 601, `max-age ${age} should track the 10 minutes left`)
  })

  it('does not reveal staging: it is a 404 like an unknown id', async () => {
    const staging = await get(`/v2/files/${FAKE.staging}`)
    const missing = await get('/v2/files/zz_test_does_not_exist')
    for (const r of [staging, missing]) {
      assert.equal(r.res.statusCode, 404)
      assert.equal(r.cache, 'public, max-age=300')
    }
    assert.equal((await get('/v2/files/constructor')).res.statusCode, 404)
    assert.equal((await get('/v2/files/bad!id')).res.statusCode, 400)
  })
})

describe('GET /v2/categories/:type', () => {
  it('counts early-access assets too', async () => {
    const { res, body, cache } = await get('/v2/categories/hdris')
    assert.equal(res.statusCode, 200)
    assert.equal(cache, 'public, max-age=3600')
    const counts = body.data as Record<string, number>
    const hdris = Object.values(assets).filter((a) => a.type === 0)
    assert.equal(counts.all, hdris.length)
    assert.equal((await get('/v2/categories/nonsense')).res.statusCode, 400)
    assert.equal((await get('/v2/categories/constructor')).res.statusCode, 400)
  })
})

describe('GET /v2/search', () => {
  it('is wrapped, keyless and cacheable, and only returns listed assets', async (t) => {
    const { res, body, cache } = await get('/v2/search?q=forest&t=hdris&limit=20')
    if (res.statusCode === 503) return t.skip('Workers AI is not configured here')
    assert.equal(res.statusCode, 200)
    assert.equal(cache, 'public, max-age=3600')
    assert.equal(body.message, 'OK')
    assert.ok(!('meta' in body))
    const results = (body.data as { results: { slug: string }[] }).results
    assert.ok(results.length > 0 && results.every((r) => r.slug in assets))
    const bad = await get('/v2/search')
    assert.equal(bad.res.statusCode, 400)
    assert.equal(bad.cache, 'public, max-age=300')
  })
})

describe('GET /v2/similar/:id', () => {
  it('serves released and early-access ids, never lists staging, and 404s a staging id', async () => {
    for (const slug of [released, earlyAccess]) {
      const { res, body, cache } = await get(`/v2/similar/${slug}`)
      assert.equal(res.statusCode, 200)
      assert.equal(cache, 'public, max-age=3600')
      const similar = body.data as Record<string, Asset>
      assert.ok(Object.keys(similar).length > 0 && !(slug in similar) && !(FAKE.staging in similar))
    }
    const staging = await get(`/v2/similar/${FAKE.staging}`)
    assert.equal(staging.res.statusCode, 404)
    assert.equal(staging.cache, 'public, max-age=300')
    assert.equal((await get('/v2/similar/bad!id')).res.statusCode, 400)
  })
})

describe('GET /v2/taxonomy', () => {
  it('wraps the v1 bodies', async () => {
    const all = await get('/v2/taxonomy')
    assert.equal(all.res.statusCode, 200)
    assert.equal(all.cache, 'public, max-age=3600')
    const v1 = (await app.inject({ method: 'GET', url: '/taxonomy' })).json()
    assert.deepEqual(all.body.data, v1)

    const hdris = await get('/v2/taxonomy/hdris')
    const v1hdris = (await app.inject({ method: 'GET', url: '/taxonomy/hdris' })).json()
    assert.deepEqual(hdris.body.data, v1hdris)
    assert.equal((await get('/v2/taxonomy/all')).res.statusCode, 400)
    assert.equal((await get('/v2/taxonomy/constructor')).res.statusCode, 400)
  })
})

describe('GET /v2/extensions', () => {
  it('is public, without meta', async () => {
    const { res, body, cache } = await get('/v2/extensions')
    assert.equal(res.statusCode, 200)
    assert.equal(cache, 'public, max-age=3600')
    assert.equal(body.message, 'OK')
    assert.ok(Array.isArray(body.data) && !('meta' in body))
    assert.equal((await get('/v2/extensions?blender_version=99.0')).res.statusCode, 200)
  })
})

describe('keyless means the same bytes for everyone', () => {
  it('ignores the Authorization header', async () => {
    const urls = [
      '/v2/assets?t=models',
      `/v2/info/${earlyAccess}`,
      `/v2/files/${released}`,
      `/v2/files/${earlyAccess}`,
      '/v2/categories/textures',
      `/v2/similar/${released}`,
      '/v2/taxonomy',
      '/v2/extensions',
    ]
    const keys = [NON_EA_KEY, 'garbage', ...(superhiveKey ? [superhiveKey] : [])]
    for (const url of urls) {
      const plain = await get(url)
      for (const key of keys) {
        const keyed = await get(url, bearer(key))
        assert.ok(keyed.res.statusCode === plain.res.statusCode, `${url}: status differs with a key`)
        assert.ok(keyed.res.body === plain.res.body, `${url}: body differs with a key`)
        assert.ok(keyed.cache === plain.cache, `${url}: cache-control differs with a key`)
      }
    }
  })
})
