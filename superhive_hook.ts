import './utils/env.ts'
import type { IncomingHttpHeaders } from 'node:http'
import type { FastifyInstance } from 'fastify'

import firestore from './firestore.ts'

// Superhive's after_sale webhook, as far as it is read here.
interface SuperhiveHook {
  status?: string
  event_type?: string
  order_item_id?: number
  order_id?: number
  order_created_at?: string
  user_id?: number
  product_id?: number
  product_name?: string
  product_variant_id?: number
  product_variant_name?: string
}

// superhive_hooks/{auto id}: the raw hook, kept until it is turned into an access token.
interface SuperhiveHookDoc {
  hook: SuperhiveHook
  access_token_created: boolean
  req_headers: IncomingHttpHeaders
  method: string
  received_at: string
  ip: string | undefined
}

export default async function (fastify: FastifyInstance) {
  fastify.post<{ Body: SuperhiveHook }>('/', async (req, reply) => {
    /*
  Expected data:
  {
    "status": "complete",
    "event_type": "after_sale",
    "order_item_id": 12345,
    "order_id": 12345,
    "order_created_at": "2025-10-21 07:50:20 -0500",
    "user_id": 12345,
    "product_id": 12345,
    "product_name": "PRODUCT NAME",
    "product_variant_id": 12345,
    "product_variant_name": "PRODUCT VARIANT NAME"
  }
    */

    // Validate body data
    if (!req.body || req.body.event_type !== 'after_sale' || req.body.user_id === undefined) {
      return reply.code(400).send({
        error: '400 Bad Request',
        message: 'Invalid request body',
      })
    }

    // Dump the data into Firestore
    /*
  TODO:
  Don't just dump the data, we need to responde with the text file that includes the extension URL and access token, and obviously also create the access token.
  */

    const db = firestore()
    const forwardedFor = req.headers['x-forwarded-for'] as string | undefined
    const document: SuperhiveHookDoc = {
      hook: req.body,
      access_token_created: false,
      req_headers: req.headers,
      method: req.method,
      received_at: new Date().toISOString(),
      ip: forwardedFor || req.ip || req.socket.remoteAddress,
    }
    await db.collection('superhive_hooks').add(document)

    return reply.code(200).send({
      document,
      message: 'OK',
    })
  })
}
