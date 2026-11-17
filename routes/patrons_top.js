import isBadWord from '../utils/isBadWord.ts'

import firestore from '../firestore.ts'

export default async function (fastify) {
  fastify.get('/', async (req, reply) => {
    const db = firestore()
    const collection = await db.collection('patrons').orderBy('lifetime_cents', 'desc').limit(30).get()

    // These are/were corporate sponsors (not individuals)
    const ignored = ['UNKNOWN', 'Graswald', 'Andrew_D', 'Luma Animation']

    let patrons = []
    collection.forEach((doc) => {
      const data = doc.data()
      if (!data.anon) {
        const name = data.display_name || data.name
        if (!isBadWord(name) && !ignored.includes(name)) {
          patrons.push([data.uid, name, Date.parse(data.joined)])
        }
      }
    })

    reply.header('Cache-Control', `max-age=${30 * 60}`)
    return reply.code(200).send(patrons)
  })
}
