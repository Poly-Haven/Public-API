const firestore = require('../firestore')

const db = firestore()

module.exports = async function (fastify) {
  fastify.get('/', async (req, reply) => {
    let collectionRef = db.collection('finances')

    const collection = await collectionRef.get()
    let docs = {}
    collection.forEach((doc) => {
      docs[doc.id] = doc.data()
    })

    return reply.code(200).send(docs)
  })
}
