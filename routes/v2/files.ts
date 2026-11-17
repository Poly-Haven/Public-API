import type { FastifyInstance } from 'fastify'

import { checkAssetId, lookupFiles } from '../../utils/v2Assets.ts'
import type { FilesLookup } from '../../utils/v2Assets.ts'
import { publicCache, sendError, sendOk, sendUnavailable } from '../../utils/v2Cache.ts'

/**
 * GET /v2/files/:id: the file list (and so the download URLs) of a released asset. Keyless. An early-access
 * asset answers 403 with its release date, and that 403 is cacheable until the moment it stops being true.
 * Staging and unknown ids are both 404: staging is never revealed. Early-access files are at /v2/ea/files/:id.
 */
export default async function (fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => sendError(reply, 400, 'Please format your request as /v2/files/[asset_id]'))

  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = req.params.id
    const bad = checkAssetId(reply, id)
    if (bad) return bad

    // A read that fails is not an asset that is missing: 503, which is never cached, not a cacheable 404.
    let lookup: FilesLookup
    try {
      lookup = await lookupFiles(id)
    } catch (err) {
      return sendUnavailable(reply, 'V2 FILES', err)
    }

    if (!lookup.found) return sendError(reply, 404, `No asset with id ${id}`)

    if (lookup.earlyAccess) {
      const until = lookup.asset.date_published
      publicCache(reply, { until })
      return sendError(reply, 403, 'Asset is in early access', { extra: { early_access_until: until } })
    }

    publicCache(reply)
    return sendOk(reply, lookup.files)
  })
}
