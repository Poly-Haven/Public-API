const escape = require('escape-html')

const firestore = require('../firestore')
const { sendText } = require('../utils/http')

const db = firestore()

module.exports = async function (fastify) {
  fastify.get('/', async (req, reply) => {
    return sendText(reply, 400, `Please format your request as /text/[id]`)
  })

  fastify.get('/:id', async (req, reply) => {
    const id = req.params.id

    const doc = await db.collection('text').doc(id).get()
    if (!doc.exists) {
      return sendText(reply, 404, `No text with id ${escape(id)}`)
    } else {
      return reply.code(200).send(doc.data())
    }
  })
}
