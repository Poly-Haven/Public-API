import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { Asset } from '../../types/firestore.ts'
import { isHiddenFromV1, setV1Allowlist, v1FreezeActive } from '../../utils/v1Freeze.ts'
import { FAKE, getApp, now } from './fixtures.ts'

// The v1 early-access freeze: the helper, and v1's routes with an allowlist injected in-process. The shipped
// allowlist is null, so everything outside this file runs with the freeze off.

const soon = { date_published: now() + 600 }
const released = { date_published: now() - 600 }

describe('isHiddenFromV1', () => {
  after(() => setV1Allowlist())

  it('does nothing while the allowlist is null', () => {
    setV1Allowlist(null)
    assert.equal(v1FreezeActive(), false)
    assert.equal(isHiddenFromV1('anything', soon, now()), false)
  })

  it('hides early-access assets that are not on the list, and nothing else', () => {
    setV1Allowlist({ frozen_at: '2026-12-31T00:00:00.000Z', slugs: ['kept'] })
    assert.equal(v1FreezeActive(), true)
    assert.equal(isHiddenFromV1('new_one', soon, now()), true)
    assert.equal(isHiddenFromV1('kept', soon, now()), false)
    assert.equal(isHiddenFromV1('new_one', released, now()), false)
    // Released since the freeze: it is simply a published asset again.
    assert.equal(isHiddenFromV1('kept', released, now()), false)
    assert.equal(isHiddenFromV1('new_one', soon, soon.date_published + 1), false)
  })

  it('is off when restored to what the file says', () => {
    setV1Allowlist()
    assert.equal(v1FreezeActive(), false)
  })
})

describe('v1 routes under a freeze', () => {
  let app: FastifyInstance
  // Two fixture early-access hdris: one on the allowlist, one not.
  const listed = FAKE.ea1
  const hidden = FAKE.ea2

  const getJson = async (url: string) => {
    const res = await app.inject({ method: 'GET', url })
    return { res, body: res.headers['content-type']?.toString().includes('json') ? res.json() : res.body }
  }

  before(async () => {
    app = await getApp()
    setV1Allowlist(null)
  })
  beforeEach(() => setV1Allowlist({ frozen_at: '2026-12-31T00:00:00.000Z', slugs: [listed] }))
  after(() => setV1Allowlist())

  it('/assets?future=true lists only the allowlisted early-access asset', async () => {
    const { body } = await getJson('/assets?t=hdris&future=true')
    const slugs = Object.keys(body)
    assert.ok(slugs.includes(listed))
    assert.ok(!slugs.includes(hidden) && !slugs.includes(FAKE.soon))
    assert.equal(slugs.filter((s) => (body as Record<string, Asset>)[s].date_published > now()).length, 1)
    assert.ok(slugs.includes(FAKE.released), 'released assets are untouched')
  })

  it('/categories/:type?future=true counts the same set', async () => {
    const { body } = await getJson('/categories/hdris?future=true')
    setV1Allowlist(null)
    const open = (await getJson('/categories/hdris?future=true')).body as Record<string, number>
    const closed = (await getJson('/categories/hdris')).body as Record<string, number>
    assert.equal((body as Record<string, number>).all, closed.all + 1)
    assert.ok(open.all > closed.all + 1)
  })

  it('/files/:id answers a hidden asset like an unknown id, and still serves the allowlisted one', async () => {
    const gone = await app.inject({ method: 'GET', url: `/files/${hidden}` })
    assert.equal(gone.statusCode, 404)
    assert.equal(gone.body, `No asset with id ${hidden}`)
    assert.equal(gone.headers['cache-control'], 'no-store')
    assert.equal((await app.inject({ method: 'GET', url: `/files/${listed}` })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/files/zz_test_does_not_exist' })).statusCode, 404)
  })

  it('/search?future=true leaves hidden assets out', async (t) => {
    const { res, body } = await getJson('/search?q=sky&t=hdris&future=true')
    if (res.statusCode === 503) return t.skip('Workers AI is not configured here')
    const slugs = (body as { results: { slug: string }[] }).results.map((r) => r.slug)
    assert.ok(!slugs.includes(hidden), 'a hidden asset was returned')
  })
})
