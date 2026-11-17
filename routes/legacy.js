const simpleData = async (type) => {
  // Reads the whole assets collection filtered by type, so use the shared cache.
  const cachedFirestore = require('../utils/cachedFirestore')
  const db = cachedFirestore()

  let collection = await db.collection('assets').where('type', '==', type).get()
  let docs = {}
  collection.forEach((doc) => {
    const data = doc.data()
    docs[doc.id] = data.tags.join(';') + ';' + data.categories.join(';')
  })

  return docs
}

module.exports = async function (fastify) {
  fastify.get('/hdris', async (req, reply) => {
    const data = require('../constants/legacy/hdris.json')
    return reply.code(200).send(data)
  })
  fastify.get('/textures', async (req, reply) => {
    const data = require('../constants/legacy/textures.json')
    return reply.code(200).send(data)
  })
  fastify.get('/models', async (req, reply) => {
    const data = require('../constants/legacy/models.json')
    return reply.code(200).send(data)
  })

  fastify.get('/hdris-simple', async (req, reply) => {
    return reply.code(200).send(await simpleData(0))
  })
  fastify.get('/textures-simple', async (req, reply) => {
    return reply.code(200).send(await simpleData(1))
  })
  fastify.get('/models-simple', async (req, reply) => {
    return reply.code(200).send(await simpleData(2))
  })
}
