import type { FastifyInstance } from 'fastify'

import type { Asset, FilesDoc } from '../../types/firestore.ts'
import type { Query } from '../../types/http.ts'
import cachedFirestore from '../../utils/cachedFirestore.ts'
import { keyAuth, requireKey } from '../../utils/keyAuth.ts'
import { assetTypes as asset_types } from '../../utils/schemas.ts'
import { checkAssetId, isEarlyAccess, lookupFiles, nowSeconds } from '../../utils/v2Assets.ts'
import type { FilesLookup } from '../../utils/v2Assets.ts'
import { sendError, sendOk, sendUnavailable } from '../../utils/v2Cache.ts'
import { hasPlainQuery } from '../../utils/v2Query.ts'

const db = cachedFirestore()

const NO_EARLY_ACCESS = 'This key does not include early access'

/**
 * The keyed early-access endpoints: the file lists (download URLs) of early-access assets, which is the only
 * part of an early-access asset that is not public. Every response here is `private, no-store`: requireKey
 * sets it before the handler runs, and the error helpers leave a Cache-Control that is already set alone.
 */
export default async function (fastify: FastifyInstance) {
  // GET /v2/ea/files/:id: any non-staging asset's files if the key has early access; a released asset's files
  // for any valid key (so a client can use one endpoint for everything).
  fastify.get<{ Params: { id: string } }>('/files/:id', { preHandler: requireKey }, async (req, reply) => {
    const id = req.params.id
    const bad = checkAssetId(reply, id)
    if (bad) return bad
    const { includeUpcoming } = keyAuth(req)

    let lookup: FilesLookup
    try {
      lookup = await lookupFiles(id)
    } catch (err) {
      return sendUnavailable(reply, 'V2 EA FILES', err, { keyed: true })
    }

    if (!lookup.found) return sendError(reply, 404, `No asset with id ${id}`)
    if (lookup.earlyAccess && !includeUpcoming) return sendError(reply, 403, NO_EARLY_ACCESS)

    return sendOk(reply, lookup.files)
  })

  // GET /v2/ea/files[?type=hdris|textures|models]: { <slug>: <files doc> } for every early-access asset.
  // Both collections come through the collection cache, so this costs no Firestore reads of its own.
  fastify.get<{ Querystring: Query }>('/files', { preHandler: requireKey }, async (req, reply) => {
    const { includeUpcoming } = keyAuth(req)
    if (!includeUpcoming) return sendError(reply, 403, NO_EARLY_ACCESS)
    if (!hasPlainQuery(req)) return sendError(reply, 400, 'Query parameters must be plain values')

    const type = req.query.type
    if (type !== undefined && !Object.hasOwn(asset_types, type)) {
      return sendError(reply, 400, `Unsupported asset type. Must be: ${Object.keys(asset_types).join('/')}`)
    }
    const typeIndex = type === undefined ? null : asset_types[type]

    const earlyAccess = new Set<string>()
    const found: Record<string, FilesDoc> = {}
    try {
      const now = nowSeconds()
      const assets = await db.collection<Asset>('assets').get()
      assets.forEach((doc) => {
        const asset = doc.data()
        if (asset.staging || !isEarlyAccess(asset, now)) return
        if (typeIndex !== null && asset.type !== typeIndex) return
        earlyAccess.add(doc.id)
      })
      const files = await db.collection<FilesDoc>('files').get()
      files.forEach((doc) => {
        if (earlyAccess.has(doc.id)) found[doc.id] = doc.data()
      })
    } catch (err) {
      return sendUnavailable(reply, 'V2 EA FILES', err, { keyed: true })
    }

    const sorted = Object.fromEntries(Object.entries(found).sort(([a], [b]) => (a < b ? -1 : 1)))
    return sendOk(reply, sorted)
  })
}
