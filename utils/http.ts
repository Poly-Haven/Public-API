// Helpers that reproduce what Express 4 did on the wire, so the Fastify port answers byte-for-byte alike.
//
//   errorPage / sendErrorPage   finalhandler's production error page (what Express sent for an unknown route,
//                               a body-parser failure, or an error thrown from a handler): fixed HTML skeleton,
//                               CSP + nosniff headers, no ETag.
//   notFoundMessage             finalhandler's "Cannot METHOD /path" text (path without query, HTML-escaped).
//   sendText                    res.send('string'): Content-Type text/html; charset=utf-8 unless the handler
//                               already set one, in which case `; charset=utf-8` is appended to it.
//   redirect                    res.redirect(status, url): Location + Vary: Accept, and a small body negotiated
//                               from Accept (text/plain, text/html, or empty). Sent without an ETag.
//   mountPath                   req.path: the raw URL path relative to the plugin's mount prefix.
//   qsParse                     the 'extended' query parser, qs.parse with allowPrototypes (Express 4's setting).
//   addBodyParsers              express.json() / bodyParser.text() as mounted per route file: parsing only under
//                               the mount points that had a parser (see JSON_MOUNTS), with body-parser's charset
//                               and 400/413/415 rules; every other path ignores the body ({}).
//   redactUrl                   a url with the Superhive webhook's secret path segment replaced, for log lines.
//   noEtag                      marks a reply that Express would not have given an ETag (the app's ETag hook
//                               skips it). res.send() always adds one; finalhandler and res.end() never do.
import { STATUS_CODES } from 'node:http'
import type { IncomingMessage } from 'node:http'
import accepts from 'accepts'
import { encodeUrl } from 'encodeurl'
import escapeHtml from 'escape-html'
import qs from 'qs'
import contentType from 'content-type'
import iconv from 'iconv-lite'
import typeis from 'type-is'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

const JSON_LIMIT = 102400 // express.json() / bodyParser.text() default of '100kb'

const noEtagReplies = new WeakSet<FastifyReply>()
const noEtag = (reply: FastifyReply) => {
  noEtagReplies.add(reply)
  return reply
}
const skipsEtag = (reply: FastifyReply) => noEtagReplies.has(reply)

const errorPage = (message: string) =>
  `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Error</title>
</head>
<body>
<pre>${escapeHtml(message)}</pre>
</body>
</html>
`

const sendErrorPage = (reply: FastifyReply, status: number, message: string) => {
  noEtag(reply)
  return reply
    .code(status)
    .header('Content-Security-Policy', "default-src 'none'")
    .header('X-Content-Type-Options', 'nosniff')
    .type('text/html; charset=utf-8')
    .send(errorPage(message))
}

// parseurl's pathname: everything before the first ? (or #).
const pathnameOf = (url: string) => url.split(/[?#]/, 1)[0]

// originalUrl, as finalhandler uses: the path as the client sent it, before the app's mount-point rewrite.
const notFoundMessage = (req: FastifyRequest) =>
  `Cannot ${req.method} ${encodeUrl(pathnameOf(req.originalUrl || req.url))}`

const sendText = (reply: FastifyReply, status: number, text: string) => {
  const type = reply.getHeader('content-type') as string | undefined
  if (!type) {
    reply.type('text/html; charset=utf-8')
  } else if (!/;\s*charset=/i.test(type)) {
    reply.type(`${type}; charset=utf-8`)
  }
  return reply.code(status).send(text)
}

const redirect = (req: FastifyRequest, reply: FastifyReply, status: number, location: string) => {
  const message = STATUS_CODES[status]
  const kind = accepts(req.raw).type(['text', 'html'])
  let body = ''
  reply.header('Location', encodeUrl(location)).header('Vary', 'Accept')
  if (kind === 'text') {
    reply.type('text/plain; charset=utf-8')
    body = `${message}. Redirecting to ${encodeUrl(location)}`
  } else if (kind === 'html') {
    reply.type('text/html; charset=utf-8')
    body = `<p>${message}. Redirecting to ${escapeHtml(encodeUrl(location))}</p>`
  }
  // With nothing acceptable the body is empty and Express sent it untyped; the app's onSend hook strips the type.
  return noEtag(reply).code(status).send(body)
}

// `prefix` is fastify.prefix inside a plugin. Routing is case-insensitive but the prefix length is fixed,
// so slicing is safe; the result is not percent-decoded, like Express's req.path.
const mountPath = (prefix: string, req: FastifyRequest) => pathnameOf(req.url).slice(prefix.length) || '/'

const qsParse = (str: string) => qs.parse(str, { allowPrototypes: true })

interface HttpError extends Error {
  statusCode: number
}
type BodyKind = 'json' | 'text'
interface Plan {
  kind: BodyKind | null
  charset: string | null
  original: string | undefined
}

const httpError = (status: number): HttpError => Object.assign(new Error(STATUS_CODES[status]), { statusCode: status })

// What fastify-plugin sets so a plugin's hooks stay on the root instance instead of an encapsulated child.
// Hooks are order-sensitive here, so the app registers its own with this rather than depending on the package.
const skipOverride = <T extends object>(plugin: T): T => {
  ;(plugin as Record<symbol, unknown>)[Symbol.for('skip-override')] = true
  return plugin
}

// body-parser's strict JSON parse: only objects and arrays are accepted at the top level.
const parseJson = (body: string): unknown => {
  if (body.length === 0) return {}
  const first = body.trimStart()[0]
  if (first !== '{' && first !== '[') throw httpError(400)
  try {
    return JSON.parse(body)
  } catch (err) {
    throw httpError(400)
  }
}

// Express parsed bodies per router, not globally: each route file below did `router.use(express.json())`
// (or `bodyParser.text({ type: '*/*' })` for the Patreon hook), which ran for EVERY request under that mount
// point - including unknown sub-paths and any method - and nowhere else. So a bad body on those paths failed
// with the parser's status (400/413/415) before routing could answer 404, while on every other path the body
// was never looked at. Keep these two lists in step with the route files that read req.body.
const JSON_MOUNTS = () => [
  '/clear_cache',
  '/course_progress',
  '/dl_track',
  '/gallery_click',
  '/lighthouse_key',
  '/patron_info',
  '/sponsor',
  '/track_search',
  '/v2/create_key',
  '/v2/superhive_' + process.env.SUPERHIVE_KEY,
]
const TEXT_MOUNTS = () => ['/patreon_hook']

// Express's mount-point match: case-insensitive prefix, then an optional slash, then end or another slash.
const mountMatcher = (mounts: string[]) =>
  new RegExp('^(?:' + mounts.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')/?(?=/|$)', 'i')
let mountMatchers: { json: RegExp; text: RegExp } | null = null

const bodyKind = (req: FastifyRequest): BodyKind | null => {
  if (!mountMatchers) mountMatchers = { json: mountMatcher(JSON_MOUNTS()), text: mountMatcher(TEXT_MOUNTS()) }
  const path = pathnameOf(req.url)
  if (mountMatchers.json.test(path)) return 'json'
  if (mountMatchers.text.test(path)) return 'text'
  return null
}

// body-parser's getCharset: the Content-Type charset parameter, lower-cased; undefined if there is none or the
// header does not parse (the last of a repeated parameter wins).
const charsetOf = (raw: IncomingMessage) => {
  try {
    return (contentType.parse(raw).parameters.charset || '').toLowerCase() || undefined
  } catch (err) {
    return undefined
  }
}

// What express.json() / bodyParser.text() did before reading anything: no body (neither Content-Length nor
// Transfer-Encoding) or a type it does not handle -> skipped, req.body stays {}; json with a charset that is
// not utf-* -> 415; any charset iconv-lite cannot decode -> 415. Returns the charset to decode with, or null to
// skip. Note iconv-lite does know utf-16/utf-7 and friends, so those pass here and then most fail in the JSON
// parse as 400, exactly as in Express.
const checkBody = (raw: IncomingMessage, kind: BodyKind | null) => {
  if (!kind || !typeis.hasBody(raw)) return null
  if (!typeis(raw, kind === 'json' ? 'application/json' : '*/*')) return null
  const charset = charsetOf(raw) || 'utf-8'
  if (kind === 'json' && charset.slice(0, 4) !== 'utf-') throw httpError(415)
  if (!iconv.encodingExists(charset)) throw httpError(415)
  return charset
}

// What the onRequest hook worked out for a request (see addBodyParsers): the kind of body parser Express would
// have run and the charset it would decode with, or null when it would have skipped the body.
const plans = new WeakMap<IncomingMessage, Plan>()

// One parser for every content type (and no content type), deciding per mount point as Express did.
const bodyParser = (
  req: FastifyRequest,
  payload: IncomingMessage,
  done: (err: Error | null, body?: unknown) => void
) => {
  const { kind, charset } = plans.get(req.raw) || {}
  let failed = false
  const fail = (err: Error) => {
    if (failed) return
    failed = true
    payload.resume()
    done(err)
  }
  const chunks: Buffer[] = []
  let size = 0
  // raw-body refused a declared length over the limit before reading a byte.
  if (charset && Number(req.headers['content-length']) > JSON_LIMIT) return fail(httpError(413))
  payload.on('data', (chunk) => {
    if (failed || !charset) return
    size += chunk.length
    if (size > JSON_LIMIT) return fail(httpError(413))
    chunks.push(chunk)
  })
  payload.on('error', fail)
  payload.on('end', () => {
    if (failed) return
    // Skipped: the body is drained and ignored, as Express left req.body as {}.
    if (!charset) return done(null, {})
    try {
      const text = iconv.decode(Buffer.concat(chunks), charset)
      done(null, kind === 'json' ? parseJson(text) : text)
    } catch (err) {
      done((err as Partial<HttpError>).statusCode ? (err as Error) : httpError(400))
    }
  })
  payload.resume()
}

const bodyHooks = skipOverride(async (instance: FastifyInstance) => {
  // The charset rules (415) fire here rather than in the parser because Express applied them to every request
  // with a Content-Length or Transfer-Encoding - an empty body included, which Fastify never hands to a parser -
  // and before routing, so an unknown sub-path under a mount point answered 415 too. The header is swapped for
  // a harmless type meanwhile: Fastify answers 415 itself to a Content-Type it cannot parse ('garbage', empty),
  // where Express ignored the body of any type it did not handle. The original goes back, in the same place,
  // before the handler runs, since the Superhive hook stores the request headers in their original order.
  instance.addHook('onRequest', async (req) => {
    const headers = req.raw.headers
    const original = headers['content-type']
    const kind = bodyKind(req)
    const charset = checkBody(req.raw, kind)
    plans.set(req.raw, { kind, charset, original })
    if (original !== undefined) headers['content-type'] = 'application/octet-stream'
  })
  instance.addHook('preHandler', async (req) => {
    const plan = plans.get(req.raw)
    if (plan && plan.original !== undefined) req.raw.headers['content-type'] = plan.original
    // Express always had a req.body: {} if nothing parsed it, '' for the text parser on an empty body.
    if (req.body === undefined) req.body = plan && plan.kind === 'text' && plan.charset ? '' : {}
  })
})

const addBodyParsers = (fastify: FastifyInstance) => {
  fastify.removeAllContentTypeParsers()
  fastify.addContentTypeParser('*', bodyParser)
  // Queued after the CORS and ETag plugins so an error answered from the hook still carries their headers.
  fastify.register(bodyHooks)
}

/**
 * A request url that is safe to log: the Superhive webhook's path carries a shared secret (/v2/superhive_<secret>),
 * which must not end up in PM2's log files. Matched case-insensitively because routing is.
 */
const redactUrl = (url: string): string => url.replace(/(\/v2\/superhive_)[^/?#]*/i, '$1[redacted]')

export {
  addBodyParsers,
  skipOverride,
  errorPage,
  mountPath,
  noEtag,
  notFoundMessage,
  qsParse,
  redactUrl,
  redirect,
  sendErrorPage,
  sendText,
  skipsEtag,
}
