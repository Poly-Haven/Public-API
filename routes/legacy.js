import cachedFirestore from '../utils/cachedFirestore.ts'

const simpleData = async (type) => {
  // Reads the whole assets collection filtered by type, so use the shared cache.
  const db = cachedFirestore()

  let collection = await db.collection('assets').where('type', '==', type).get()
  let docs = {}
  collection.forEach((doc) => {
    const data = doc.data()
    docs[doc.id] = data.tags.join(';') + ';' + data.categories.join(';')
  })

  return docs
}

export default async function (fastify) {
  fastify.get('/hdris', async (req, reply) => {
    // Loaded on first use, as the require() it replaces was: these are large and rarely asked for.
    const { default: data } = await import('../constants/legacy/hdris.json', { with: { type: 'json' } })
    return reply.code(200).send(data)
  })
  fastify.get('/textures', async (req, reply) => {
    // Loaded on first use, as the require() it replaces was: these are large and rarely asked for.
    const { default: data } = await import('../constants/legacy/textures.json', { with: { type: 'json' } })
    return reply.code(200).send(data)
  })
  fastify.get('/models', async (req, reply) => {
    // Loaded on first use, as the require() it replaces was: these are large and rarely asked for.
    const { default: data } = await import('../constants/legacy/models.json', { with: { type: 'json' } })
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
