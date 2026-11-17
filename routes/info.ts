import escape from 'escape-html'
import type { FastifyInstance } from 'fastify'

import type { Asset } from '../types/firestore.ts'

import firestore from '../firestore.ts'
import { sendText } from '../utils/http.ts'
import { thumbnailUrl } from '../utils/imgUrl.ts'
import { publicVaultIds, maskVault } from '../utils/vaultStatus.ts'

const db = firestore()

export default async function (fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return sendText(reply, 400, `Please format your request as /info/[asset_id]`)
  })

  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const asset_id = req.params.id

    // Uncacheable by default; the success branch below opts back in. The error branches used to
    // just omit Cache-Control and rely on the edge leaving them alone, but this zone overrides
    // origin cache headers - so a 404 for an asset that is about to exist could be pinned at the
    // edge for hours, long enough to outlive the publish that created the asset.
    reply.header('Cache-Control', 'no-store')

    if (!asset_id) {
      return sendText(reply, 400, `No asset with that ID`)
    }

    const MAX_ID_LENGTH = 50
    if (asset_id.length > MAX_ID_LENGTH) {
      return sendText(reply, 400, `No asset with that ID`)
    }

    const validPattern = /^[a-zA-Z0-9_-]+$/
    if (!validPattern.test(asset_id)) {
      return sendText(reply, 400, `No asset with that ID`)
    }

    const doc = await db.collection('assets').doc(asset_id).get()
    if (!doc.exists) {
      return sendText(reply, 404, `No asset with id ${escape(asset_id)}`)
    } else {
      // reviewers is internal review metadata and has no business in a public response. /assets and
      // /v2/assets have always stripped it, this endpoint just never did. Destructured rather than
      // deleted so the doc is never mutated, in case this route ever moves onto the shared cache.
      const { reviewers, ...unmasked } = doc.data() as Asset
      // An asset in a vault that hasn't been announced is attributed to "an upcoming vault" only -
      // this is the response its asset page is built from.
      const data = maskVault(unmasked, await publicVaultIds())
      // Add thumbnail URL
      data.thumbnail_url = thumbnailUrl(asset_id, data)
      // Asset data only changes on publish, and publishing purges the CDN. Overrides the
      // no-store set at the top of the handler.
      reply.header('Cache-Control', 'public, max-age=43200, s-maxage=43200, stale-while-revalidate=86400')
      return reply.code(200).send(data)
    }
  })
}
