import type { FastifyInstance } from 'fastify'

import type { Query } from '../../types/http.ts'
import cachedFirestore from '../../utils/cachedFirestore.ts'
import { publicCache, sendError, sendUnavailable } from '../../utils/v2Cache.ts'
import { hasPlainQuery } from '../../utils/v2Query.ts'

const db = cachedFirestore()

/** An `extension/{id}` doc: one release of the paid add-on. */
interface Extension {
  version: string
  blender_version_min: string
  [key: string]: unknown
}

const compare = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

/**
 * GET /v2/extensions[?blender_version=4.2]: the add-on's releases, or with blender_version only the highest
 * one that version can run. Public and the same for everyone. (Unrelated to /extensions, the Blender
 * extensions repository for the asset library.)
 */
export default async function (fastify: FastifyInstance) {
  fastify.get<{ Querystring: Query }>('/', async (req, reply) => {
    if (!hasPlainQuery(req)) return sendError(reply, 400, 'Query parameters must be plain values')
    const blenderVersion = req.query.blender_version

    const compatible: Record<string, Extension> = {}
    try {
      const collection = await db.collection<Extension>('extension').get()
      collection.forEach((doc) => {
        const ext = doc.data()
        if (!blenderVersion || compare(ext.blender_version_min, blenderVersion) <= 0) compatible[doc.id] = ext
      })
    } catch (err) {
      return sendUnavailable(reply, 'V2 EXTENSIONS', err)
    }

    const data: Extension[] = []
    if (blenderVersion) {
      // Only the highest compatible version.
      const highest = Object.keys(compatible).sort((a, b) => compare(compatible[b].version, compatible[a].version))[0]
      if (highest) data.push(compatible[highest])
    } else {
      for (const id in compatible) data.push(compatible[id])
    }

    publicCache(reply)
    return reply.code(200).send({ version: 'v1', blocklist: [], data, message: 'OK' })
  })
}
