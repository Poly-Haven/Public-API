import '../utils/env.ts'
import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import firestore from '../firestore.ts'
import type { Patron, PatreonHookPayload } from '../types/firestore.ts'
import { patreonTiers as patreon_tiers } from '../utils/schemas.ts'

let lastHook: string | null = null

// Posts to the Discord webhook. What hookcord sent: the payload as JSON, nothing else.
const postToDiscord = async (payload: object) => {
  const res = await fetch(process.env.DISCORD_PATRON_HOOK as string, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Discord webhook answered ${res.status}`)
}

const centsToRank = (cents: number, yearly_pledge: boolean) => {
  let c = cents
  if (yearly_pledge) {
    c = c / 12
  }
  if (c <= 300) {
    return 1
  } else if (c <= 500) {
    return 2
  } else if (c <= 1000) {
    return 3
  } else if (c <= 5000) {
    return 4
  }
  return 5
}

const grantToken = (data: Patron, previousData: Patron | null): [Patron, boolean] => {
  let granted = false

  if (!previousData) {
    // Initial user creation, payment not made yet.
    return [data, granted]
  }

  if (data.lifetime_cents <= previousData.lifetime_cents) {
    // No payment made, probably just user updated
    return [data, granted]
  }

  const now = new Date()
  const tokenKey = `${now.getFullYear()}-${now.getMonth() + 1}`

  if (previousData.sponsor_tokens && Object.keys(previousData.sponsor_tokens).includes(tokenKey)) {
    // Token already used
    return [data, granted]
  }

  data.sponsor_tokens = {}
  data.sponsor_tokens[tokenKey] = false
  granted = true
  return [data, granted]
}

export default async function (fastify: FastifyInstance) {
  // The signature check needs the body byte-exact: the global body parser hands this mount the raw string for
  // any content type, and leaves {} when the request had none (as bodyParser.text did).
  fastify.post<{ Body: string }>('/', async (req, reply) => {
    const webhookSecret = process.env.PATREON_HOOK_SECRET as string
    const hash = crypto.createHmac('md5', webhookSecret).update(req.body).digest('hex')
    const success = req.headers['x-patreon-signature'] === hash
    const data = JSON.parse(req.body) as PatreonHookPayload
    data.hook = req.headers['x-patreon-event'] as string | undefined
    data.timestamp = new Date().toISOString()

    if (!success) {
      console.log('Signature received: ' + req.headers['x-patreon-signature'])
      console.log('Signature generated: ' + hash)
      console.log('Signature validation status: ' + success)

      return reply.code(403).send({
        error: '403 Forbidden',
        message: 'Incorrect secret',
      })
    }

    const db = firestore()

    const docID =
      Date.now().toString() +
      Math.floor(Math.random() * 1000)
        .toString()
        .padStart(3, '0')
    db.collection('patreon_hooks').doc(docID).set(data)

    let uid = ''
    try {
      uid = data.data.relationships.user.data.id
    } catch (e) {
      return reply.code(400).send({
        error: '400',
        message: "Couldn't get uid",
      })
    }

    // Built field by field, in this order, so the document is written exactly as it always was.
    let patron = {} as Patron
    patron.uid = uid
    patron.name = (data.data.attributes.full_name || 'UNKNOWN').trim()
    patron.joined = data.data.attributes.pledge_relationship_start
    patron.cents = data.data.attributes.currently_entitled_amount_cents
    patron.yearly_pledge = data.data.attributes.pledge_cadence === 12
    patron.rank = centsToRank(patron.cents, patron.yearly_pledge)
    patron.lifetime_cents = data.data.attributes.lifetime_support_cents
    patron.last_charge_date = data.data.attributes.last_charge_date
    patron.last_charge_status = data.data.attributes.last_charge_status
    patron.next_charge_date = data.data.attributes.next_charge_date
    patron.status = data.data.attributes.patron_status
    patron.last_edited = new Date().toISOString() // Legacy Warning: May be epoch instead of ISO string
    patron.last_hook = data.hook // TODO check if members who delete their account are still tracked as active patrons (hook = "members:delete")
    const entitled_tiers = data.data.relationships.currently_entitled_tiers.data
    if (entitled_tiers.length > 0) {
      // When a user deletes their pledge, entitled_tiers is empty, even though they are entitled for the rest of the month they paid for. So we don't set their tiers if this is the case.
      patron.tiers = []
      for (const t of entitled_tiers) {
        patron.tiers.push(t.id)
      }
    }

    if (patron.tiers && patron.status === 'active_patron') {
      for (const tier of patron.tiers) {
        if (Object.keys(patreon_tiers).includes(tier)) {
          if (patreon_tiers[tier].rewards.includes('Sponsor')) {
            const previousDoc = await db.collection('patrons').doc(uid).get()
            let previousData: Patron | null = null
            if (previousDoc.exists) {
              previousData = previousDoc.data() as Patron
            }
            const [p, granted] = grantToken(patron, previousData)
            patron = p
            if (granted) {
              const logID =
                Date.now().toString() +
                Math.floor(Math.random() * 1000)
                  .toString()
                  .padStart(3, '0')
              db.collection('log').doc(logID).set({
                type: 'granttoken',
                timestamp: new Date().toISOString(),
                uuid: patron.uid,
              })
            }
            break
          }
        }
      }
    }

    db.collection('patrons').doc(uid).set(patron, { merge: true })

    // Discord hook
    const hooksToShare = ['members:pledge:create', 'members:pledge:update', 'members:pledge:delete']
    if (hooksToShare.includes(data.hook as string)) {
      let title = '???'
      let color = 0
      let description = ''
      if (data.hook === 'members:pledge:create') {
        // For some reason we always get two of these. Remember the last one and ignore this one if it's a duplicate.
        if (lastHook === `${patron.uid}__${data.hook}__${patron.cents}`) {
          console.log(`Duplicate ${data.hook} hook, ignoring.`)
          return reply.code(200).send({
            message: 'OK',
          })
        }
        title = `New $${patron.cents / 100} patron!`
        color = 10212925
      } else if (data.hook === 'members:pledge:update') {
        title = `Pledge edited to $${patron.cents / 100}`
        color = 4307929
      } else if (data.hook === 'members:pledge:delete') {
        title = `$${patron.cents / 100} pledge deleted`
        color = 16345172
      }

      if (data.hook !== 'members:pledge:create') {
        description += `Joined: ${new Date(patron.joined).toLocaleDateString('en-ZA')}`
        if (patron.lifetime_cents) {
          description += `\nLifetime: $${patron.lifetime_cents / 100}`
        }
      }

      lastHook = `${patron.uid}__${data.hook}__${patron.cents}`

      postToDiscord({
        embeds: [
          {
            title: title,
            description: description,
            url: `https://www.patreon.com/user?u=${patron.uid}`,
            type: 'rich',
            color: color,
            thumbnail: {
              url: `https://c8.patreon.com/2/36/${patron.uid}`,
            },
            author: {
              name: patron.name,
              url: `https://www.patreon.com/user?u=${patron.uid}`,
            },
          },
        ],
      }).catch(console.error)
    }

    return reply.code(200).send({
      message: 'OK',
    })
  })
}
