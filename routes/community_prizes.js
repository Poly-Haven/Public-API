import firestore from '../firestore.ts'

const db = firestore()

export default async function (fastify) {
  fastify.get('/', async (req, reply) => {
    const collection = await db.collection('community_prizes').get()
    let docs = {}
    collection.forEach((doc) => {
      docs[doc.id] = doc.data()
    })

    return reply.code(200).send(docs)
  })
}
