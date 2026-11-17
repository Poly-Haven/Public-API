import '../utils/env.ts'
import crypto from 'crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { FieldValue } from 'firebase-admin/firestore' // for FieldValue
import firestore from '../firestore.ts'

const db = firestore()

// What polyhaven.com's proxy posts. Checked field by field, so each is optional here.
interface CourseProgressBody {
  uuid?: string
  key?: string
  lastLecture?: unknown
  completed?: unknown
}

// same trust check as patron_info.ts: the Next.js route proves session ownership
// and signs uuid with PATRON_INFO_KEY; we re-derive and compare.
function validate(req: FastifyRequest<{ Body: CourseProgressBody }>, reply: FastifyReply): string | null {
  if (!req.body || !req.body.uuid || !req.body.key) {
    reply.code(400).send({ error: '400', message: 'Bad request.' })
    return null
  }
  const uuid = req.body.uuid
  const hash = crypto.createHmac('sha256', process.env.PATRON_INFO_KEY!).update(uuid).digest('hex')
  if (req.body.key !== hash) {
    reply.code(403).send({ error: '403 Forbidden', message: 'Incorrect key' })
    return null
  }
  return uuid
}

export default async function (fastify: FastifyInstance) {
  // Read a user's progress.
  fastify.post<{ Body: CourseProgressBody }>('/', async (req, reply) => {
    const uuid = validate(req, reply)
    if (!uuid) return reply
    const doc = await db.collection('course_progress').doc(uuid).get()
    return reply.code(200).send(doc.exists ? doc.data() : { completed: [], lastLecture: null })
  })

  // Update progress: append completed lecture(s) atomically + set the last lecture.
  fastify.patch<{ Body: CourseProgressBody }>('/', async (req, reply) => {
    const uuid = validate(req, reply)
    if (!uuid) return reply

    const update: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }
    if (req.body.lastLecture) update.lastLecture = req.body.lastLecture
    if (req.body.completed) {
      const slugs = ([] as unknown[]).concat(req.body.completed)
      update.completed = FieldValue.arrayUnion(...slugs)
    }

    await db.collection('course_progress').doc(uuid).set(update, { merge: true })
    return reply.code(200).send({ error: null, message: 'OK' })
  })
}
