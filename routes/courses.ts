import escape from 'escape-html'
import type { FastifyInstance } from 'fastify'

import type { OpenDoc } from '../types/firestore.ts'

import firestore from '../firestore.ts'
import { sendText } from '../utils/http.ts'

const db = firestore()

export default async function (fastify: FastifyInstance) {
  // GET /courses — all courses, keyed by id
  fastify.get('/', async (req, reply) => {
    const col = await db.collection('courses').get()
    let courses: Record<string, OpenDoc> = {}
    col.forEach((doc) => {
      courses[doc.id] = doc.data() as OpenDoc
      courses[doc.id].id = doc.id
    })
    return reply.code(200).send(courses)
  })

  // GET /courses/:id — a single course
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = req.params.id

    if (!id) {
      return sendText(reply, 400, `No course with that ID`)
    }
    const MAX_ID_LENGTH = 50
    if (id.length > MAX_ID_LENGTH) {
      return sendText(reply, 400, `No course with that ID`)
    }
    const validPattern = /^[a-zA-Z0-9_-]+$/
    if (!validPattern.test(id)) {
      return sendText(reply, 400, `No course with that ID`)
    }

    const doc = await db.collection('courses').doc(id).get()
    if (!doc.exists) {
      return sendText(reply, 404, `No course with id ${escape(id)}`)
    } else {
      const data = doc.data() as OpenDoc
      data.id = doc.id
      return reply.code(200).send(data)
    }
  })
}
