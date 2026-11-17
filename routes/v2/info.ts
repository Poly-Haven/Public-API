import type { FastifyInstance } from 'fastify'

import type { Asset } from '../../types/firestore.ts'
import { publicAsset } from '../../utils/assetList.ts'
import cachedFirestore from '../../utils/cachedFirestore.ts'
import { checkAssetId } from '../../utils/v2Assets.ts'
import { publicCache, sendError, sendOk, sendUnavailable } from '../../utils/v2Cache.ts'
import { publicVaultIds } from '../../utils/vaultStatus.ts'

const db = cachedFirestore()

/**
 * GET /v2/info/:id: one asset's metadata, as an item of /v2/assets. Early-access assets are served (their
 * metadata is public); staging and unknown ids are both 404.
 */
export default async function (fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => sendError(reply, 400, 'Please format your request as /v2/info/[asset_id]'))

  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = req.params.id
    const bad = checkAssetId(reply, id)
    if (bad) return bad

    let raw: Asset | null
    let publicVaults: Set<string>
    try {
      raw = (await db.collection<Asset>('assets').doc(id).get()).data()
      publicVaults = await publicVaultIds()
    } catch (err) {
      return sendUnavailable(reply, 'V2 INFO', err)
    }

    const asset = raw && publicAsset(id, raw, publicVaults)
    if (!asset) return sendError(reply, 404, `No asset with id ${id}`)

    publicCache(reply)
    return sendOk(reply, asset)
  })
}
