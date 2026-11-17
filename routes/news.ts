import type { FastifyInstance } from 'fastify'

import type { NewsItem } from '../types/firestore.ts'

import cachedFirestore from '../utils/cachedFirestore.ts'

const cachedDb = cachedFirestore()

export default async function (fastify: FastifyInstance) {
  fastify.get('/', async (req, reply) => {
    const now = new Date().toISOString()
    const collection = await cachedDb.collection('news').get()
    let docs: NewsItem[] = []
    collection.forEach((doc) => {
      const data = doc.data() as NewsItem
      if (data.active && data.date_start <= now && data.date_end >= now) {
        data.key = doc.id
        docs.push(data)
      }
    })
    return reply.code(200).send(docs)
  })

  // News/announcements for the Blender add-on.
  fastify.get('/blender', async (req, reply) => {
    const now = new Date().toISOString()
    const collection = await cachedDb.collection('news_blender').get()
    let docs: NewsItem[] = []
    collection.forEach((doc) => {
      const data = doc.data() as NewsItem
      if (data.active && data.date_start <= now && data.date_end >= now) {
        data.key = doc.id
        docs.push(data)
      }
    })
    reply.header('Cache-Control', 'public, max-age=3600') // 1h edge cache
    return reply.code(200).send(docs)
  })
}
