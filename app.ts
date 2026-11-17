import './utils/env.ts'
import fs from 'node:fs'
import { STATUS_CODES } from 'node:http'
import type { IncomingMessage } from 'node:http'
import path from 'node:path'
import cors from '@fastify/cors'
import etag from '@fastify/etag'
import Fastify from 'fastify'
import type { FastifyError, FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import fresh from 'fresh'
import { parse as parseYaml } from 'yaml'

import superhiveHook from './superhive_hook.ts'
import {
  addBodyParsers,
  notFoundMessage,
  qsParse,
  redirect,
  sendErrorPage,
  skipOverride,
  skipsEtag,
} from './utils/http.ts'

const TOS = 'https://github.com/Poly-Haven/Public-API/blob/master/ToS.md'

const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Creates the Fastify instance and registers everything on it - plugins, hooks, every route file - and waits
// for it to be ready, but does not listen. server.ts does that, and tests can inject requests into the result.
//
// Every route is registered, and fastify.ready() awaited, before anything listens. Without that, requests
// in the first moments after a restart would fall through to the 404 handler, which the Cloudflare edge
// then cached for 12h.
export const buildApp = async (): Promise<FastifyInstance> => {
  // Mount points of the route files (filled in as they are registered) and every registered route, for the two
  // Express quirks below that depend on them.
  const mountPrefixes: string[] = []
  const registeredRoutes: { methods: string[]; url: string }[] = []
  let mountSlashRegex: RegExp | null = null

  // Express matched a mount point as ^/prefix/?(?=/|$), so one extra slash straight after it was swallowed:
  // /info//moss_rock behaved like /info/moss_rock, /assets// like /assets/. Nothing else tolerates a double slash.
  const rewriteUrl = (req: IncomingMessage) => {
    const url = req.url as string
    // The one place Fastify is more forgiving than Express: with ignoreTrailingSlash its router trims a single
    // trailing slash, which turns a bare `//` into the root route. Express answered 404 (the root is `/` plus at
    // most one slash). Every other double-slash path already agrees, and no other route is hit the same way: the
    // trimmed form of `/x//` is `/x/`, and a trailing slash after the swallowed one never matched in Express either.
    // Pad it to a path no route has; the 404 message still reads the original url.
    if (/^\/\/(?=$|[?#])/.test(url)) return '/' + url
    if (!mountSlashRegex) {
      const alternatives = mountPrefixes.map(escapeRegExp)
      mountSlashRegex = new RegExp('^(' + alternatives.join('|') + ')/(?=/)', 'i')
    }
    return url.replace(mountSlashRegex, '$1')
  }

  // A path with bad percent-encoding. Express only decodes the params of a route that matched, and answered
  // 400 there; a path matching no parameterised route was an ordinary 404. Fastify fails the whole path before
  // routing, so work out which of the two Express would have given. The hooks (CORS, ToS) never ran for it.
  const matchesParamRoute = (req: FastifyRequest) => {
    const method = req.method === 'HEAD' ? 'GET' : req.method
    const pathname = req.url.split(/[?#]/, 1)[0]
    return registeredRoutes.some(({ methods, url }) => {
      if (!methods.includes(method) || !/[:*]/.test(url)) return false
      const pattern = url
        .split('/')
        .map((seg) => (seg === '*' ? '.*' : seg.startsWith(':') ? '[^/]+' : escapeRegExp(seg)))
        .join('/')
      return new RegExp('^' + pattern + '/?$', 'i').test(pathname)
    })
  }
  const badUrl = (err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    reply.header('Access-Control-Allow-Origin', '*').header('Terms-Of-Service', TOS)
    if (matchesParamRoute(req)) return sendErrorPage(reply, 400, STATUS_CODES[400] as string)
    return sendErrorPage(reply, 404, notFoundMessage(req))
  }

  // Router options mirror Express's defaults, which the public URLs rely on: case-insensitive paths (route
  // params keep their original case), optional trailing slash, duplicate slashes left alone (bar the mount-point
  // quirk above), and Express's extended (qs) query parser so ?a[]=1&a[b]=2 parse as before. trustProxy stays
  // off, as in Express.
  const fastify = Fastify({
    logger: false,
    trustProxy: false,
    // Express's body limit; the JSON and text parsers set their own, this one only guards other bodies.
    bodyLimit: 102400,
    // Idle keep-alive sockets must not hold up close(): they used to stall a PM2 reload to the 4s fallback.
    forceCloseConnections: 'idle',
    // Node's own http defaults, which Express ran with (Fastify's would be 72s and unlimited).
    keepAliveTimeout: 5000,
    requestTimeout: 300000,
    routerOptions: {
      caseSensitive: false,
      ignoreTrailingSlash: true,
      ignoreDuplicateSlashes: false,
      querystringParser: qsParse,
      // Express had no limit on a param's length; the router default (100) 404s e.g. /info/<150 chars> before the
      // handler can answer "No asset with that ID". Node already caps the whole request line at 16 KB, so this
      // is simply "never".
      maxParamLength: 65536,
    },
    rewriteUrl,
    frameworkErrors: badUrl,
  })

  fastify.addHook('onRoute', (opts) => {
    registeredRoutes.push({ methods: ([] as string[]).concat(opts.method), url: opts.url })
  })

  fastify.register(cors, {
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    strictPreflight: false, // Express's cors() answered every OPTIONS, with or without Access-Control-Request-Method
  })

  // Weak ETag on every string/Buffer response, like res.send(). The 304 is done in the hook below instead of
  // by the plugin, which would match only a single exact If-None-Match and does so for any status.
  fastify.register(etag, { weak: true, replyWith304: false })

  let debugRequests = false
  const isDev = process.env.NODE_ENV === 'development'
  // Logs the request url to the console
  fastify.addHook('onRequest', async (req) => {
    if (debugRequests || isDev) {
      // Random emoji to make it easier to find in the logs, using the current second as the seed
      const emojiOptions = ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸']
      const emoji = emojiOptions[new Date().getSeconds() % emojiOptions.length]
      console.log(emoji, req.url)
    }
  })

  // A plugin rather than a bare addHook so it is queued after the ETag plugin: onSend hooks run in registration
  // order, and this one has to see the ETag that plugin sets. skipOverride is what fastify-plugin does, keeping
  // the hook on the root instance instead of an encapsulated child.
  const onSendHeaders = skipOverride(async (instance: FastifyInstance) => {
    instance.addHook('onSend', async (req, reply, payload) => {
      // Add the ToS to every response. Not to CORS preflights: Express answered those from cors(), which sat
      // ahead of the ToS middleware, so they never had it.
      if (req.method !== 'OPTIONS') {
        reply.header('Terms-Of-Service', TOS)
      }

      // Express added no ETag to error pages and redirects (finalhandler / res.end), but did to everything
      // sent with res.send(); the ETag plugin above adds one to all string/Buffer payloads, so undo that.
      if (skipsEtag(reply)) {
        reply.removeHeader('etag')
        // A redirect nothing was acceptable for: Express sent an empty, untyped body, but send('') types it.
        if (payload === '') reply.removeHeader('content-type')
        return payload
      }

      // req.fresh: 304 for GET/HEAD on a 2xx when If-None-Match matches (list, weak and `*` forms included)
      // and the client didn't send Cache-Control: no-cache. Express dropped the body and its headers.
      const status = reply.statusCode
      if ((req.method === 'GET' || req.method === 'HEAD') && status >= 200 && status < 300 && payload != null) {
        if (fresh(req.headers, { etag: reply.getHeader('etag') as string | undefined })) {
          reply.code(304)
          reply.removeHeader('content-type')
          reply.removeHeader('content-length')
          reply.removeHeader('transfer-encoding')
          // Fastify's own HEAD handler, which runs after this hook, chokes on a null payload (and sets
          // Content-Length: 0, the one header on this 304 that Express didn't send).
          return req.method === 'HEAD' ? '' : null
        }
      }
      return payload
    })
  })
  fastify.register(onSendHeaders)

  addBodyParsers(fastify)

  // Unknown routes, and known routes hit with the wrong method (no 405, as in Express).
  fastify.setNotFoundHandler((req, reply) => sendErrorPage(reply, 404, notFoundMessage(req)))

  // Express's finalhandler, production mode: the status text, never err.message.
  fastify.setErrorHandler((err: FastifyError, req, reply) => {
    let status = err.statusCode as number
    if (!(status >= 400 && status <= 599)) status = 500
    if (status >= 500) console.error(`[ERROR] ${req.method} ${req.url}:`, err)
    return sendErrorPage(reply, status, STATUS_CODES[status] as string)
  })

  const swaggerDocument = parseYaml(fs.readFileSync(path.join(import.meta.dirname, 'swagger.yml'), 'utf8'))
  fastify.get('/api-docs/swagger.json', async () => swaggerDocument)

  // Debug toggle endpoint
  fastify.post<{ Params: { state: string } }>('/debug/:state', async (req, reply) => {
    const authHeader = req.headers.authorization
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null

    if (token !== process.env.DL_KEY) {
      return reply.code(403).send({
        error: '403 Forbidden',
        message: 'Incorrect key',
      })
    }

    const { state } = req.params
    if (state === 'on') {
      debugRequests = true
    } else if (state === 'off') {
      debugRequests = false
    } else {
      return reply.code(400).send({
        error: '400 Bad Request',
        message: 'Invalid state. Use "on" or "off"',
      })
    }

    return reply.send({
      debug: debugRequests,
      message: `Request logging ${debugRequests ? 'enabled' : 'disabled'}`,
      node: process.env.NODE_ID || 'UNKNOWN',
    })
  })

  const mount = (prefix: string, plugin: FastifyPluginAsync) => {
    mountPrefixes.push(prefix)
    fastify.register(plugin, { prefix })
  }
  // Route files are plugins: `export default async function (fastify) {...}`, mounted at /<file name>, and
  // those in a subdirectory (v2/) at /<dir>/<file name>.
  const loadRoute = async (relPath: string) => {
    const mod = (await import(new URL(relPath, import.meta.url).href)) as { default: FastifyPluginAsync }
    return mod.default
  }
  const routeDir = path.join(import.meta.dirname, 'routes')
  for (const file of fs.readdirSync(routeDir)) {
    const stats = fs.statSync(path.join(routeDir, file))

    if (stats.isFile() && file.endsWith('.ts')) {
      // Handle regular route files
      const fn = file.split('.')[0]
      if (fn === 'tmp' && process.env.NODE_ENV !== 'development') continue
      mount('/' + fn, await loadRoute('./routes/' + file))
    } else if (stats.isDirectory()) {
      // Handle subdirectories (like v2/)
      for (const subFile of fs.readdirSync(path.join(routeDir, file))) {
        if (subFile.endsWith('.ts')) {
          const subFn = subFile.split('.')[0]
          mount('/' + file + '/' + subFn, await loadRoute('./routes/' + file + '/' + subFile))
        }
      }
    }
  }

  // Superhive webhook endpoint
  mount('/v2/superhive_' + process.env.SUPERHIVE_KEY, superhiveHook)

  fastify.get('/', async (req, reply) => {
    return reply.code(200).type('text/html; charset=utf-8').send(`Welcome to the Poly Haven API!
  Documentation for available endpoints is here:
  https://redocly.github.io/redoc/?url=https://api.polyhaven.com/api-docs/swagger.json&nocors
  A short guide for agents and LLM tools is here:
  https://polyhaven.com/llms.txt`)
  })

  // Agents look for these.
  fastify.get('/llms.txt', async (req, reply) => redirect(req, reply, 301, 'https://polyhaven.com/llms.txt'))
  fastify.get('/openapi.json', async (req, reply) =>
    redirect(req, reply, 301, 'https://api.polyhaven.com/api-docs/swagger.json')
  )

  await fastify.ready()
  return fastify
}
