'use strict'
/*
 * Replays a corpus and hand-written write cases against two running servers and reports every difference.
 *
 *   node test/parity/diff.js --old http://127.0.0.1:3001 --new http://127.0.0.1:3002 \
 *        --corpus <corpus.json> --cases <dir> --out <dir> --env <.env of the app> --ctx <context.json> \
 *        [--old-log <PARITY_WRITE_LOG of old>] [--new-log <PARITY_WRITE_LOG of new>] \
 *        [--only <prefix>] [--skip-corpus] [--skip-cases] [--skip-ratelimit] [--concurrency 6] [--limit N]
 *
 * Both servers must have been started through guard.js (serve.sh does this). Secrets are read from --env at run
 * time and are redacted from every output file.
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const {
  isDiscordHookCall,
  alignCounters,
  normalizeBody,
  normalizeText,
  normalizeWrite,
  keyOrderRandom,
  numericTolerance,
  nonDeterministicBody,
} = require('./normalize')

// ------------------------------------------------------------------ args
const args = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue
  const k = argv[i].slice(2)
  if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) args[k] = true
  else args[k] = argv[++i]
}
for (const req of ['old', 'new', 'out', 'env']) if (!args[req]) die('missing --' + req)
function die(m) {
  console.error(m)
  process.exit(2)
}
const OLD = new URL(args.old)
const NEW = new URL(args.new)
const OUT = args.out
fs.mkdirSync(OUT, { recursive: true })
const CONC = +(args.concurrency || 6)

// ------------------------------------------------------------------ secrets / templating
const ENV = {}
for (const line of fs.readFileSync(args.env, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
  if (!m) continue
  let v = m[2].trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  ENV[m[1]] = v
}
const CTX = args.ctx && fs.existsSync(args.ctx) ? JSON.parse(fs.readFileSync(args.ctx, 'utf8')) : {}
const SECRETS = []
for (const [k, v] of Object.entries(ENV))
  if (v.length >= 8 && !/^(production|development)$/.test(v) && !/^NEXT_PUBLIC/.test(k)) SECRETS.push([k, v])
for (const [k, v] of Object.entries(CTX)) if (v && String(v).length >= 8) SECRETS.push(['ctx:' + k, String(v)])
SECRETS.sort((a, b) => b[1].length - a[1].length)
const redact = (s) => {
  if (typeof s !== 'string') return s
  for (const [k, v] of SECRETS) if (s.includes(v)) s = s.split(v).join(`<${k}>`)
  return s
}
const redactDeep = (x) => JSON.parse(redact(JSON.stringify(x)))

class Skip extends Error {}
function resolveTemplate(str, body) {
  let s = str
  for (let guard = 0; guard < 10 && /\{\{[^{}]+\}\}/.test(s); guard++) {
    s = s.replace(/\{\{([^{}]+)\}\}/g, (all, expr) => {
      const [kind, ...rest] = expr.split(':')
      const arg = rest.join(':')
      if (kind === 'env') {
        if (!(arg in ENV)) throw new Skip('env ' + arg + ' not set')
        return ENV[arg]
      }
      if (kind === 'ctx') {
        if (!CTX[arg]) throw new Skip('ctx ' + arg + ' unavailable')
        return CTX[arg]
      }
      if (kind === 'hmac') {
        const [envName, ...t] = arg.split(':')
        if (!(envName in ENV)) throw new Skip('env ' + envName + ' not set')
        return crypto.createHmac('sha256', ENV[envName]).update(t.join(':')).digest('hex')
      }
      if (kind === 'md5sig') {
        // Patreon's webhook signature: HMAC-MD5 of the raw body with the shared secret
        if (!(arg in ENV)) throw new Skip('env ' + arg + ' not set')
        return crypto
          .createHmac('md5', ENV[arg])
          .update(body || '')
          .digest('hex')
      }
      throw new Error('unknown template ' + all)
    })
  }
  return s
}
const resolveDeep = (x, body) => {
  if (typeof x === 'string') return resolveTemplate(x, body)
  if (Array.isArray(x)) return x.map((y) => resolveDeep(y, body))
  if (x && typeof x === 'object')
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, resolveDeep(v, body)]))
  return x
}

// ------------------------------------------------------------------ http
const agents = new Map()
const agentFor = (u) => {
  if (!agents.has(u.host)) agents.set(u.host, new http.Agent({ keepAlive: true, maxSockets: CONC + 2 }))
  return agents.get(u.host)
}
const safePath = (p) =>
  p.replace(/[^\x21-\x7e]/g, (c) =>
    [...Buffer.from(c)].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('')
  )

function send(base, { method, path: p, headers = {}, body, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const h = { ...headers }
    if (body !== undefined && body !== null && !('content-length' in h)) h['content-length'] = Buffer.byteLength(body)
    else if (['POST', 'PUT', 'PATCH'].includes(method) && !('content-length' in h)) h['content-length'] = 0
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      resolve({ ms: Date.now() - t0, ...r })
    }
    let req
    try {
      req = http.request(
        { hostname: base.hostname, port: base.port, method, path: safePath(p), headers: h, agent: agentFor(base) },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => finish({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
          res.on('error', (e) => finish({ error: 'response:' + (e.code || e.message) }))
        }
      )
    } catch (e) {
      return finish({ error: 'request:' + (e.code || e.message) })
    }
    req.setTimeout(timeoutMs, () => {
      finish({ error: 'timeout' })
      req.destroy()
    })
    req.on('error', (e) => finish({ error: 'request:' + (e.code || e.message) }))
    if (body !== undefined && body !== null) req.write(body)
    req.end()
  })
}

// ------------------------------------------------------------------ comparison
const HEADERS = [
  'content-type',
  'cache-control',
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'terms-of-service',
  'location',
  'vary',
  'x-ph-early-access',
  'retry-after',
  'allow',
  'content-encoding',
  'content-disposition',
  'last-modified',
  'access-control-max-age',
  'access-control-allow-credentials',
  'access-control-expose-headers',
]
// note: x-powered-by is Express-specific and expected to go away; date/connection/keep-alive/content-length are transport.

// First path segments that are real routes (see build-corpus.js); anything else is scanner junk, grouped as one prefix.
const KNOWN = new Set(
  'assets author authors bl_repo categories clear_cache collections community_prizes corporate course_progress courses dl_track extensions files finances funding gallery gallery_click image_versions info legacy lighthouse_key milestones news patreon_hook patron_info patrons patrons_latest patrons_top ping popularity renders rss search similar sponsor stats taxonomy text timelines track_search translation_progress types vaults v2 api-docs debug llms.txt openapi.json tmp'.split(
    ' '
  )
)
const prefixOf = (url) => {
  const segs = url.split('?')[0].split('/').filter(Boolean)
  if (!segs.length) return '/'
  if (!KNOWN.has(segs[0].toLowerCase())) return '(unknown path)'
  if (segs[0] === 'v2' && segs[1]) return '/v2/' + (segs[1].startsWith('superhive_') ? 'superhive_*' : segs[1])
  return '/' + segs[0].toLowerCase()
}
const pathnameOf = (url) => url.split('?')[0]
const short = (v, n = 80) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s === undefined ? 'undefined' : s.length > n ? s.slice(0, n) + '...' : s
}

function jsonDiff(a, b, p, out, limit, tol = 0) {
  if (out.length >= limit) return
  if (a === b) return
  if (
    tol &&
    typeof a === 'number' &&
    typeof b === 'number' &&
    Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b))
  )
    return
  const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a
  const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b
  if (ta !== tb) return void out.push(`${p || '$'}: type ${ta} vs ${tb} (${short(a, 40)} vs ${short(b, 40)})`)
  if (ta === 'array') {
    if (a.length !== b.length) out.push(`${p || '$'}: array length ${a.length} vs ${b.length}`)
    for (let i = 0; i < Math.min(a.length, b.length) && out.length < limit; i++)
      jsonDiff(a[i], b[i], `${p}[${i}]`, out, limit, tol)
    return
  }
  if (ta === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    for (const k of ka) if (!(k in b)) out.push(`${p}.${k}: only in old`)
    for (const k of kb) if (!(k in a)) out.push(`${p}.${k}: only in new`)
    for (const k of ka) if (k in b && out.length < limit) jsonDiff(a[k], b[k], `${p}.${k}`, out, limit, tol)
    return
  }
  out.push(`${p || '$'}: ${short(a, 50)} vs ${short(b, 50)}`)
}

function contextDiff(a, b) {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const from = Math.max(0, i - 30)
  return `first difference at char ${i} (len ${a.length} vs ${b.length}): old=${JSON.stringify(a.slice(from, i + 50))} new=${JSON.stringify(b.slice(from, i + 50))}`
}

const isJsonType = (r) => /json/i.test(r.headers['content-type'] || '')

function compareResponses(entry, a, b) {
  const diffs = []
  if (a.error || b.error) {
    if (a.error === b.error) return { diffs, errored: true, errorKind: a.error }
    diffs.push({ aspect: 'error', detail: `old=${a.error || 'ok ' + a.status} new=${b.error || 'ok ' + b.status}` })
    return { diffs, errored: true }
  }
  if (a.status !== b.status) diffs.push({ aspect: 'status', detail: `old=${a.status} new=${b.status}` })
  for (const h of HEADERS) {
    const x = a.headers[h]
    const y = b.headers[h]
    if (x !== y) diffs.push({ aspect: 'header:' + h, detail: `old=${short(x)} new=${short(y)}` })
  }
  if (!!a.headers.etag !== !!b.headers.etag)
    diffs.push({ aspect: 'etag-presence', detail: `old=${!!a.headers.etag} new=${!!b.headers.etag}` })

  const pn = pathnameOf(entry.url || entry.path)
  const ta = a.body.toString('utf8')
  const tb = b.body.toString('utf8')
  let ja
  let jb
  let aOk = false
  let bOk = false
  if (isJsonType(a) || isJsonType(b)) {
    try {
      ja = JSON.parse(ta)
      aOk = true
    } catch (e) {
      /* not JSON */
    }
    try {
      jb = JSON.parse(tb)
      bOk = true
    } catch (e) {
      /* not JSON */
    }
  }
  if (aOk && bOk) {
    const na = normalizeBody(pn, ja)
    const nb = normalizeBody(pn, jb)
    alignCounters(na, nb)
    const out = []
    jsonDiff(na, nb, '', out, 5, numericTolerance(pn))
    if (out.length) diffs.push({ aspect: 'body', detail: out.join(' | ') })
    else if (!keyOrderRandom(pn) && !numericTolerance(pn) && JSON.stringify(na) !== JSON.stringify(nb))
      diffs.push({ aspect: 'body-key-order', detail: contextDiff(JSON.stringify(na), JSON.stringify(nb)) })
  } else if (aOk !== bOk) {
    diffs.push({
      aspect: 'body',
      detail: `one side is not JSON: old ${aOk ? 'json' : 'text'} new ${bOk ? 'json' : 'text'}; ${contextDiff(ta, tb)}`,
    })
  } else {
    const na = normalizeText(pn, ta)
    const nb = normalizeText(pn, tb)
    if (na !== nb) diffs.push({ aspect: 'body', detail: contextDiff(na, nb) })
  }
  return { diffs, errored: false }
}

// ------------------------------------------------------------------ run state
const results = [] // {id, kind, method, url, outcome, diffs}
const counts = {} // prefix -> {identical, different, errored}
const sigs = new Map() // `${aspect} ${prefix}` -> {n, example}
const skipped = []
const bothFailed = []
const record = (kind, label, prefix, cmp, extra = {}) => {
  const c = (counts[prefix] = counts[prefix] || { identical: 0, different: 0, errored: 0 })
  let outcome = 'identical'
  if (cmp.errored && !cmp.diffs.length) bothFailed.push(`${label.method} ${label.url}: both ${cmp.errorKind}`) // same failure on both sides counts as identical, but is listed
  if (cmp.diffs.length) outcome = cmp.errored ? 'errored' : 'different'
  c[outcome]++
  if (outcome !== 'identical') {
    results.push({ kind, ...label, prefix, outcome, diffs: cmp.diffs, ...extra })
    for (const d of cmp.diffs.length ? cmp.diffs : [{ aspect: 'error', detail: cmp.errorKind }]) {
      const k = `${d.aspect} ${prefix}`
      const s = sigs.get(k) || {
        aspect: d.aspect,
        prefix,
        n: 0,
        example: `${label.method} ${label.url}`,
        detail: d.detail,
      }
      s.n++
      sigs.set(k, s)
    }
  }
}

// ------------------------------------------------------------------ corpus replay
const onlyOk = (s) => !args.only || s.startsWith(args.only)
function corpusRequest(entry, idx) {
  const headers = { ...(entry.headers || {}) }
  // A distinct client IP per entry keeps /search's per-IP rate limiter out of the comparison (it is tested separately).
  headers['cf-connecting-ip'] = `10.${(idx >> 16) & 255}.${(idx >> 8) & 255}.${idx & 255}`
  if (entry.auth && entry.auth !== 'none') {
    const key = entry.auth === 'unknown' ? '0'.repeat(64) : entry.auth === 'ea' ? CTX.key_ea : CTX.key_plain
    if (!key) throw new Skip('no ' + entry.auth + ' key in context')
    headers.authorization = 'Bearer ' + key
  }
  return { method: entry.method, path: entry.url, headers }
}

const etagSamples = {}
async function replayEntry(entry, idx) {
  let req
  try {
    req = corpusRequest(entry, idx)
  } catch (e) {
    if (e instanceof Skip) return skipped.push(`${entry.method} ${entry.url} (${entry.auth}): ${e.message}`)
    throw e
  }
  const [a, b] = await Promise.all([send(OLD, req), send(NEW, req)])
  const cmp = compareResponses(entry, a, b)
  const label = {
    method: entry.method,
    url: redact(entry.url) + (entry.auth ? ` [auth=${entry.auth}]` : ''),
    tag: entry.tag,
  }
  const prefix = prefixOf(entry.url)
  // 304 round trip on a sample of cacheable 200s
  if (
    !cmp.errored &&
    entry.method === 'GET' &&
    a.status === 200 &&
    a.headers.etag &&
    b.headers.etag &&
    !nonDeterministicBody(pathnameOf(entry.url))
  ) {
    etagSamples[prefix] = (etagSamples[prefix] || 0) + 1
    if (etagSamples[prefix] <= 2) {
      // Production data moves under us (download_count is live), so if the body changed between the two requests the
      // first etag is legitimately stale: refetch once and retry with the fresh etag before calling it a failure.
      const conditional = async (base, etag) => {
        let r = await send(base, { ...req, headers: { ...req.headers, 'if-none-match': etag } })
        if (r.status === 200) {
          const fresh = await send(base, req)
          if (fresh.headers && fresh.headers.etag && fresh.headers.etag !== etag)
            r = await send(base, { ...req, headers: { ...req.headers, 'if-none-match': fresh.headers.etag } })
        }
        return r
      }
      const [a2, b2] = await Promise.all([conditional(OLD, a.headers.etag), conditional(NEW, b.headers.etag)])
      if (a2.status !== 304 || b2.status !== 304)
        cmp.diffs.push({
          aspect: '304',
          detail: `if-none-match round trip: old=${a2.status || a2.error} new=${b2.status || b2.error} (expected 304 on both)`,
        })
    }
  }
  record('corpus', label, prefix, cmp, { oldStatus: a.status, newStatus: b.status })
}

async function runCorpus() {
  if (!args.corpus) return
  let corpus = JSON.parse(fs.readFileSync(args.corpus, 'utf8')).map((e, i) => ({ ...e, __i: i }))
  corpus = corpus.filter((e) => onlyOk(e.url))
  if (args.limit) corpus = corpus.slice(0, +args.limit)
  console.log(`corpus: ${corpus.length} requests, concurrency ${CONC}`)
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < corpus.length) {
      const e = corpus[next++]
      try {
        await replayEntry(e, e.__i + 1)
      } catch (err) {
        record('corpus', { method: e.method, url: redact(e.url) }, prefixOf(e.url), {
          diffs: [{ aspect: 'harness-error', detail: String(err.stack || err) }],
          errored: true,
        })
      }
      if (++done % 200 === 0) console.log(`  ${done}/${corpus.length}`)
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker))
}

// ------------------------------------------------------------------ write cases
const logLines = (file) => {
  if (!file || !fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadCases() {
  if (!args.cases) return []
  const files = fs
    .readdirSync(args.cases)
    .filter((f) => f.endsWith('.json'))
    .sort()
  const all = []
  for (const f of files)
    for (const c of JSON.parse(fs.readFileSync(path.join(args.cases, f), 'utf8'))) all.push({ ...c, __file: f })
  return all.filter((c) => onlyOk(c.path) || (args.only && c.__file.startsWith(args.only.replace(/^\//, ''))))
}

async function runCase(c) {
  const build = () => {
    let body
    if (c.bodyRaw !== undefined) body = resolveTemplate(c.bodyRaw, '')
    else if (c.body !== undefined) body = JSON.stringify(resolveDeep(c.body, ''))
    const headers = {}
    const ct = c.contentType !== undefined ? c.contentType : body !== undefined ? 'application/json' : null
    if (ct) headers['content-type'] = ct
    for (const [k, v] of Object.entries(resolveDeep(c.headers || {}, body)))
      if (v !== null) headers[k.toLowerCase()] = v
    return { method: c.method, path: resolveTemplate(c.path, body), headers, body, timeoutMs: c.timeoutMs || 8000 }
  }
  let req
  try {
    req = build()
  } catch (e) {
    if (e instanceof Skip) return skipped.push(`case "${c.name}" (${c.__file}): ${e.message}`)
    throw e
  }
  // 'x-patreon-signature' templates need the body: resolved above via resolveDeep(c.headers, body)
  const oldBefore = logLines(args['old-log']).length
  const newBefore = logLines(args['new-log']).length
  const [a, b] = await Promise.all([send(OLD, req), send(NEW, req)])
  if (Math.max(a.ms, b.ms) > 2000)
    console.log(
      '  slow case ' +
        c.__file +
        ' :: ' +
        c.name +
        ' old=' +
        (a.error || a.status) +
        '/' +
        a.ms +
        'ms new=' +
        (b.error || b.status) +
        '/' +
        b.ms +
        'ms'
    )
  await sleep(c.timeoutMs ? 400 : 250) // un-awaited writes (dl_track, gallery_click, discord) land after the response
  const cmp = compareResponses({ url: c.path, path: c.path }, a, b)
  const recs = (file, from) =>
    logLines(file)
      .slice(from)
      .map((l) => JSON.parse(l))
      .filter((r) => !isDiscordHookCall(r))
  const wa = recs(args['old-log'], oldBefore).map((r) => JSON.stringify(normalizeWrite(r)))
  const wb = recs(args['new-log'], newBefore).map((r) => JSON.stringify(normalizeWrite(r)))
  const sa = [...wa].sort()
  const sb = [...wb].sort()
  if (JSON.stringify(sa) !== JSON.stringify(sb)) {
    const onlyA = sa.filter((x) => !sb.includes(x))
    const onlyB = sb.filter((x) => !sa.includes(x))
    cmp.diffs.push({
      aspect: 'writes',
      detail: `old ${wa.length} records, new ${wb.length}; only-old: ${short(onlyA, 300)} only-new: ${short(onlyB, 300)}`,
    })
  } else if (JSON.stringify(wa) !== JSON.stringify(wb)) {
    cmp.diffs.push({ aspect: 'writes-order', detail: 'same records, different order' })
  }
  const label = { method: c.method, url: `${redact(c.path)} :: ${c.name}`, tag: 'case:' + c.__file }
  record('case', label, prefixOf(resolveTemplate(c.path, '')), cmp, {
    oldStatus: a.status || a.error,
    newStatus: b.status || b.error,
    writesOld: wa.length,
    writesNew: wb.length,
  })
  return { a, b, wa, wb }
}

async function runCases() {
  if (!args.cases || args['skip-cases']) return
  const cases = loadCases()
  console.log(`cases: ${cases.length}`)
  const ordered = [...cases.filter((c) => !c.last), ...cases.filter((c) => c.last)]
  for (const c of ordered) {
    try {
      await runCase(c)
    } catch (err) {
      record('case', { method: c.method, url: `${redact(c.path)} :: ${c.name}` }, prefixOf(c.path), {
        diffs: [{ aspect: 'harness-error', detail: String(err.stack || err) }],
        errored: true,
      })
    }
  }
}

// ------------------------------------------------------------------ rate limit (per-IP /search limiter)
async function runRateLimit() {
  if (args['skip-ratelimit'] || args.only || args['skip-corpus']) return
  const N = 160
  // A fresh client IP per run, so a rerun inside the limiter's one-minute window is not already throttled.
  const ip = `10.200.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`
  const mk = (base) => async () => {
    const seq = []
    let first429
    for (let i = 0; i < N; i++) {
      const r = await send(base, { method: 'GET', path: '/search?q=rock', headers: { 'cf-connecting-ip': ip } })
      seq.push(r.status || r.error)
      if (r.status === 429 && !first429)
        first429 = {
          status: r.status,
          retryAfter: r.headers['retry-after'],
          body: r.body.toString(),
          type: r.headers['content-type'],
        }
    }
    return { seq, first429 }
  }
  const [x, y] = await Promise.all([mk(OLD)(), mk(NEW)()])
  const diffs = []
  const idx = (s) => s.indexOf(429)
  if (idx(x.seq) !== idx(y.seq))
    diffs.push({
      aspect: 'ratelimit-threshold',
      detail: `first 429 at request #${idx(x.seq) + 1} (old) vs #${idx(y.seq) + 1} (new)`,
    })
  // Retry-After (and the 'try again in Ns' text) count down from the bucket's oldest entry, so two servers that were
  // hit a few hundred ms apart legitimately differ by a second: compare them with a 2s tolerance.
  // The 429 text embeds the same countdown ("Try again in 57s" vs "56s"), so it gets the same 2s tolerance; the
  // rest of the text must match exactly.
  const retry = (r) => (r ? { ...r, retryAfter: undefined, body: String(r.body).replace(/\d+s/, 'Ns') } : r)
  const ra = (r) => (r ? +r.retryAfter : NaN)
  const secsInBody = (r) => (r ? +(/in (\d+)s/.exec(String(r.body)) || [])[1] : NaN)
  if (x.first429 && y.first429 && !(Math.abs(secsInBody(x.first429) - secsInBody(y.first429)) <= 2))
    diffs.push({
      aspect: 'ratelimit-body-seconds',
      detail: `old=${secsInBody(x.first429)} new=${secsInBody(y.first429)}`,
    })
  if (x.first429 && y.first429 && Math.abs(ra(x.first429) - ra(y.first429)) > 2)
    diffs.push({ aspect: 'ratelimit-retry-after', detail: `old=${ra(x.first429)} new=${ra(y.first429)}` })
  if (JSON.stringify(retry(x.first429)) !== JSON.stringify(retry(y.first429)))
    diffs.push({ aspect: 'ratelimit-response', detail: `old=${short(x.first429, 200)} new=${short(y.first429, 200)}` })
  record('ratelimit', { method: 'GET', url: `/search?q=rock x${N} same IP` }, '/search', { diffs, errored: false })
}

// ------------------------------------------------------------------ main
;(async () => {
  const t0 = Date.now()
  if (!args['skip-corpus']) await runCorpus()
  await runCases()
  await runRateLimit()

  const prefixes = Object.keys(counts).sort()
  const lines = []
  lines.push(
    `parity run ${new Date().toISOString()}  old=${args.old} new=${args.new}  ${((Date.now() - t0) / 1000).toFixed(0)}s`
  )
  lines.push('')
  lines.push('prefix'.padEnd(28) + 'identical'.padStart(10) + 'different'.padStart(10) + 'errored'.padStart(9))
  const tot = { identical: 0, different: 0, errored: 0 }
  for (const p of prefixes) {
    const c = counts[p]
    lines.push(
      p.padEnd(28) + String(c.identical).padStart(10) + String(c.different).padStart(10) + String(c.errored).padStart(9)
    )
    for (const k of Object.keys(tot)) tot[k] += c[k]
  }
  lines.push(
    'TOTAL'.padEnd(28) +
      String(tot.identical).padStart(10) +
      String(tot.different).padStart(10) +
      String(tot.errored).padStart(9)
  )
  lines.push('')
  lines.push(`distinct mismatch signatures (aspect + route prefix): ${sigs.size}`)
  for (const s of [...sigs.values()].sort((a, b) => b.n - a.n))
    lines.push(
      `  ${String(s.n).padStart(5)}x  ${s.aspect}  ${s.prefix}\n         e.g. ${redact(s.example)}\n         ${redact(short(s.detail, 260))}`
    )
  if (bothFailed.length) {
    lines.push('')
    lines.push(`both servers failed identically (timeout/connection) ${bothFailed.length}:`)
    for (const s of bothFailed.slice(0, 40)) lines.push('  ' + redact(s))
  }
  if (skipped.length) {
    lines.push('')
    lines.push(`skipped ${skipped.length}:`)
    for (const s of skipped.slice(0, 15)) lines.push('  ' + redact(s))
    if (skipped.length > 15) lines.push(`  ...and ${skipped.length - 15} more`)
  }
  const summary = redact(lines.join('\n')) + '\n'
  fs.writeFileSync(path.join(OUT, 'summary.txt'), summary)
  fs.writeFileSync(
    path.join(OUT, 'report.json'),
    JSON.stringify(
      redactDeep({ totals: tot, counts, signatures: [...sigs.values()], skipped, bothFailed, mismatches: results }),
      null,
      1
    )
  )
  console.log('\n' + summary)
  for (const a of agents.values()) a.destroy()
  process.exit(0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
