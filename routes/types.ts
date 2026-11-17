import type { FastifyInstance } from 'fastify'

export default async function (fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => {
    return reply.code(200).send(['hdris', 'textures', 'models'])
  })
}
