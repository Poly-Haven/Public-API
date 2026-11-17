// Shared set-up for the v2 tests. They read production Firestore, which holds no staging asset and no key that
// lacks early access, so those cases are made up: a few documents added in this process only, to the results
// of the collection reads the API's cache makes (assets, files, api_keys) and to the one api_keys query that
// POST /v2/create_key makes for a patron. Nothing is written anywhere (the write guard is preloaded).
import fs from 'node:fs'
import crypto from 'node:crypto'
import { CollectionReference, Query } from 'firebase-admin/firestore'
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
}

const randomKey = () => crypto.randomBytes(32).toString('hex')
/** Valid, active, belongs to a patron who does not exist (so: no early access). Fresh per run, not a real credential. */
export const NON_EA_KEY = randomKey()
export const REVOKED_KEY = randomKey()
export const EXISTING_PATRON_KEY = randomKey()

const asset = (extra: Record<string, unknown>) => ({
  name: 'Test asset',
  type: 0,
  categories: [],
  tags: [],
  authors: {},
  ...extra,
})

const fakeDocs: Record<string, { id: string; data: Record<string, unknown> }[]> = {
  assets: [
    { id: FAKE.staging, data: asset({ staging: true, date_published: now() - 86400 }) },
    { id: FAKE.soon, data: asset({ date_published: now() + 600 }) },
    { id: FAKE.released, data: asset({ date_published: now() - 86400 }) },
  ],
  files: [FAKE.staging, FAKE.soon, FAKE.released].map((id) => ({
    id,
    data: { blend: { url: `https://example.test/${id}` } },
  })),
  api_keys: [
    { id: NON_EA_KEY, data: { status: 'active', patron_uid: FAKE.patron, ref: 'nonea0test0' } },
    { id: REVOKED_KEY, data: { status: 'revoked', patron_uid: FAKE.patron, ref: 'revoked0tst' } },
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

  // create_key's "active keys of this patron" query, answered for one made-up patron only.
  const queryGet = Query.prototype.get
  Query.prototype.get = async function (this: Query) {
    const { _queryOptions: options } = this as unknown as InternalQuery
    const patronFilter = options.filters.find((f) => f.field.segments[0] === 'patron_uid')
    if (options.collectionId === 'api_keys' && patronFilter?.value === FAKE.patronWithKey) {
      const data = {
        status: 'active',
        patron_uid: FAKE.patronWithKey,
        ref: 'existing0key',
        created_at: '2026-01-01T00:00:00.000Z',
      }
      return snapshotOf([{ id: EXISTING_PATRON_KEY, data: () => data }]) as unknown as ReturnType<typeof queryGet.call>
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

/** The Superhive key in production api_keys, read at runtime and never printed. Null if there is none. */
export const readSuperhiveKey = async (): Promise<string | null> => {
  const { default: firestore } = await import('../../firestore.ts')
  const snapshot = await firestore().collection('api_keys').get()
  let found: string | null = null
  // The fixtures above are added to the same read, but never carry a superhive_uid.
  snapshot.forEach((doc) => {
    const data = doc.data()
    if (!found && data.superhive_uid && data.status === 'active') found = doc.id
  })
  return found
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
