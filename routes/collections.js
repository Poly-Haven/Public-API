import shuffleArray from '../utils/shuffleArray.ts'

import firestore from '../firestore.ts'
import cachedFirestore from '../utils/cachedFirestore.ts'
import { matchesCollection } from '../utils/assetFilters.ts'

const db = firestore()
const cachedDb = cachedFirestore()

export default async function (fastify) {
  fastify.get('/', async (req, reply) => {
    const collection = await db.collection('collections').orderBy('date_published', 'desc').get()
    let docs = {}
    collection.forEach((doc) => {
      docs[doc.id] = doc.data()
    })

    // Membership comes from the first-class `collections` field (falling back to the legacy
    // "collection: <id>" category string). One pass over the cached assets instead of a query each.
    const allAssets = await cachedDb.collection('assets').get()
    const byCollection = {}
    allAssets.forEach((doc) => {
      const asset = doc.data()
      for (const id in docs) {
        if (matchesCollection(asset, id)) {
          byCollection[id] = byCollection[id] || []
          byCollection[id].push(doc.id)
        }
      }
    })

    for (const id in docs) {
      docs[id].assets = shuffleArray(byCollection[id] || []).slice(0, 15)
    }

    return reply.code(200).send(docs)
  })
}
