export default async function (fastify) {
  fastify.get('/', async (req, reply) => {
    return reply.code(200).send(['hdris', 'textures', 'models'])
  })
}
