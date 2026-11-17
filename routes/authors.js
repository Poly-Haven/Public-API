import firestore from '../firestore.ts'
import cachedFirestore from '../utils/cachedFirestore.ts'

const db = firestore()
// This route sweeps the entire assets collection on every request, so read that one through the
// shared cache. Everything else stays on the direct client to keep the cache small.
const cachedDb = cachedFirestore()

export default async function (fastify) {
  fastify.get('/', async (req, reply) => {
    const colAssets = await cachedDb.collection('assets').get()
    const assets = {}
    colAssets.forEach((doc) => {
      assets[doc.id] = doc.data()
    })

    const assetCounts = {}
    for (const asset of Object.values(assets)) {
      for (const author of Object.keys(asset.authors)) {
        if (assetCounts[author]) {
          assetCounts[author]++
        } else {
          assetCounts[author] = 1
        }
      }
    }

    const colAuthors = await db.collection('authors').get()
    const authors = {}
    colAuthors.forEach((doc) => {
      const ac = assetCounts[doc.id] || 0
      if (ac !== 0) {
        authors[doc.id] = doc.data()
        authors[doc.id].assetCount = assetCounts[doc.id] || 0
      }
    })

    return reply.code(200).send(authors)
  })
}
