const firestore = require('../firestore')

const db = firestore()

module.exports = async function (fastify) {
  fastify.get('/', async (req, reply) => {
    const doc = await db.collection('locales').doc('translation_progress').get()
    const data = doc.data()
    // A missing doc gave Express's res.json(undefined): an empty body still typed as JSON.
    if (data === undefined) return reply.code(200).type('application/json; charset=utf-8').send('')
    return reply.code(200).send(data)
  })
}
