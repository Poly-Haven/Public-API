import escape from 'escape-html'

import firestore from '../firestore.ts'
import { sendText } from '../utils/http.ts'

const db = firestore()

export default async function (fastify) {
  fastify.get('/', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return sendText(reply, 400, `Please format your request as /renders/[asset_id]`)
  })

  fastify.get('/:id', async (req, reply) => {
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

    const doc = await db.collection('extra_renders').doc(asset_id).get()
    if (!doc.exists) {
      return sendText(reply, 404, `No asset with id ${escape(asset_id)}`)
    } else {
      // Renders only change on publish, and publishing purges the CDN. Overrides the
      // no-store set at the top of the handler.
      reply.header('Cache-Control', 'public, max-age=43200, s-maxage=43200, stale-while-revalidate=86400')
      return reply.code(200).send(doc.data())
    }
  })
}
