// Shared set-up for the v2 tests. They read production Firestore for the real-data shapes, but everything a
// test depends on the state of is made up, so the suite passes whatever production holds today: a staging
// asset, two scheduled early-access assets (with files docs), a released one, an asset in an unannounced vault,
// keys that lack early access or are revoked, a Superhive key. They are documents added in this process only,
// to the results of the collection reads the API's cache makes (assets, files, api_keys) and to the api_keys
// query that POST /v2/create_key makes for a patron. Nothing is written anywhere (the write guard is preloaded).
import fs from 'node:fs'
import crypto from 'node:crypto'
import { CollectionReference, DocumentReference, Query } from 'firebase-admin/firestore'
import type { FastifyInstance } from 'fastify'

export const now = () => Math.floor(Date.now() / 1000)

export const FAKE = {
  staging: 'zz_test_staging',
  /** Early access, released in 10 minutes. */
  soon: 'zz_test_ea_soon',
  released: 'zz_test_released',
  patron: 'zz_test_patron',
  /** A patron whose key the create_key query finds. */
  patronWithKey: 'zz_test_patron_with_key',
  /** A patron whose only active key also carries a superhive_uid (create_key must leave it alone). */
  patronWithMixedKey: 'zz_test_patron_mixed_key',
  /** Two early-access assets, released well in the future (hdris, like the default fake asset). */
  ea1: 'zz_test_ea_one',
  ea2: 'zz_test_ea_two',
  /** In a vault that has no doc, so it counts as unannounced. */
  vaulted: 'zz_test_vaulted',
}
/** Distinctive on purpose: a fuzzy keyword search for it must not match anything else. */
export const VAULT = 'qxjz_marker'
/** Carried by every fake asset, so /similar (which falls back to tag matching for an asset without a vector) has something to match. */
export const SHARED_TAG = 'zz_test_shared_tag'
export const SUPERHIVE_UID = 424242

const randomKey = () => crypto.randomBytes(32).toString('hex')
/** Valid, active, belongs to a patron who does not exist (so: no early access). Fresh per run, not a real credential. */
export const NON_EA_KEY = randomKey()
export const REVOKED_KEY = randomKey()
export const EXISTING_PATRON_KEY = randomKey()
export const MIXED_KEY = randomKey()
/** Valid, active, a Superhive customer's (so: early access). Fresh per run, not a real credential. */
export const SUPERHIVE_KEY = randomKey()

const asset = (extra: Record<string, unknown>) => ({
  name: 'Test asset',
  type: 0,
  categories: [],
  tags: [SHARED_TAG],
  authors: {},
  // Internal fields that publicAsset must strip.
  old_id: 'old',
  reviewers: ['someone'],
  scale: 1,
  ...extra,
})

const fakeDocs: Record<string, { id: string; data: Record<string, unknown> }[]> = {
  assets: [
    { id: FAKE.staging, data: asset({ staging: true, date_published: now() - 86400 }) },
    { id: FAKE.soon, data: asset({ date_published: now() + 600 }) },
    { id: FAKE.released, data: asset({ date_published: now() - 86400 }) },
    { id: FAKE.ea1, data: asset({ date_published: now() + 7200 }) },
    { id: FAKE.ea2, data: asset({ date_published: now() + 7200 }) },
    {
      id: FAKE.vaulted,
      data: asset({
        date_published: now() + 7200,
        name: 'Zzvaulted',
        vault: VAULT,
        categories: [`vault: ${VAULT}`],
        tags: [SHARED_TAG, 'qxjz marker', VAULT],
      }),
    },
  ],
  files: [FAKE.staging, FAKE.soon, FAKE.released, FAKE.ea1, FAKE.ea2, FAKE.vaulted].map((id) => ({
    id,
    data: { blend: { url: `https://example.test/${id}` } },
  })),
  api_keys: [
    { id: NON_EA_KEY, data: { status: 'active', patron_uid: FAKE.patron, ref: 'nonea0test0' } },
    { id: REVOKED_KEY, data: { status: 'revoked', patron_uid: FAKE.patron, ref: 'revoked0tst' } },
    { id: SUPERHIVE_KEY, data: { status: 'active', superhive_uid: SUPERHIVE_UID, ref: 'superhive0t' } },
  ],
}

/** Active keys of a patron, as create_key's api_keys query finds them. */
const patronKeys: Record<string, { id: string; data: Record<string, unknown> }[]> = {
  [FAKE.patronWithKey]: [
    {
      id: EXISTING_PATRON_KEY,
      data: {
        status: 'active',
        patron_uid: FAKE.patronWithKey,
        ref: 'existing0key',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    },
  ],
  [FAKE.patronWithMixedKey]: [
    {
      id: MIXED_KEY,
      data: {
        status: 'active',
        patron_uid: FAKE.patronWithMixedKey,
        superhive_uid: SUPERHIVE_UID,
        ref: 'mixed0key00',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    },
  ],
}

const snapshotOf = (docs: { id: string; data: () => unknown }[]) => ({
  docs,
  size: docs.length,
  empty: docs.length === 0,
  forEach: (callback: (doc: { id: string; data: () => unknown }) => void) => docs.forEach(callback),
})

interface InternalQuery {
  _queryOptions: { collectionId: string; filters: { field: { segments: string[] }; value: unknown }[] }
}

let installed = false
/** Call once, before the app reads anything. */
export const installFixtures = () => {
  if (installed) return
  installed = true

  // Whole-collection reads, which is what cachedFirestore does.
  const collectionGet = CollectionReference.prototype.get
  CollectionReference.prototype.get = async function (this: CollectionReference) {
    const real = await collectionGet.call(this)
    const extra = (fakeDocs[this.id] || []).map(({ id, data }) => ({ id, data: () => data }))
    return snapshotOf([...real.docs, ...extra]) as unknown as typeof real
  }

  // Single-document reads, which v1's /files/:id makes straight on the client. The fakes answer for their own ids only.
  const docGet = DocumentReference.prototype.get
  DocumentReference.prototype.get = async function (this: DocumentReference) {
    const fake = (fakeDocs[this.parent.id] || []).find((doc) => doc.id === this.id)
    if (fake)
      return { id: fake.id, exists: true, data: () => fake.data } as unknown as Awaited<ReturnType<typeof docGet>>
    return docGet.call(this)
  } as typeof DocumentReference.prototype.get

  // create_key's "active keys of this patron" query, answered for the made-up patrons only.
  const queryGet = Query.prototype.get
  Query.prototype.get = async function (this: Query) {
    const { _queryOptions: options } = this as unknown as InternalQuery
    const patronFilter = options.filters.find((f) => f.field.segments[0] === 'patron_uid')
    const keys = typeof patronFilter?.value === 'string' ? patronKeys[patronFilter.value] : undefined
    if (options.collectionId === 'api_keys' && keys) {
      return snapshotOf(keys.map(({ id, data }) => ({ id, data: () => data }))) as unknown as ReturnType<
        typeof queryGet.call
      >
    }
    return queryGet.call(this)
  } as typeof Query.prototype.get
}

let appPromise: Promise<FastifyInstance> | null = null
/** The real app, built once per test file. API_KEY_MASTER is a made-up secret, set before the app loads. */
export const MASTER = randomKey()
export const getApp = () => {
  installFixtures()
  process.env.API_KEY_MASTER = MASTER
  // Not the development mode .env may ask for, which logs every request URL to stdout (the test runner's channel).
  process.env.NODE_ENV = 'production'
  appPromise ||= import('../../app.ts').then((mod) => mod.buildApp())
  return appPromise
}

/** What the write guard recorded since `fromByte`, as parsed JSON lines. */
export const writesSince = (fromByte: number): { op: string; path: string; data?: Record<string, unknown> }[] => {
  const log = process.env.PARITY_WRITE_LOG as string
  const text = fs.readFileSync(log).subarray(fromByte).toString('utf8')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}
export const writeLogSize = () => {
  const log = process.env.PARITY_WRITE_LOG as string
  return fs.existsSync(log) ? fs.statSync(log).size : 0
}

export const bearer = (key: string) => ({ authorization: `Bearer ${key}` })
