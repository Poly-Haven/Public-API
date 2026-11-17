'use strict'
/*
 * Normalisation rules for the parity differ. EVERY rule exists only because the field is genuinely
 * non-deterministic between two correct instances of the same code on the same data (request-time clocks,
 * random shuffles, process-local counters). Each carries a `why`. A rule may blank or sort a FIELD; it never
 * discards a whole body. Anything that is not covered here is compared exactly.
 *
 * Rules are validated by calibration: baseline-vs-baseline must produce zero differences, so a rule that is not
 * needed there should not exist, and a difference that survives there needs a rule here (with a reason).
 */

const PLACEHOLDER = (what) => `<${what}>`

// Replace the value at a dotted path. `*` matches every key of an object or every item of an array.
function setPath(obj, dotted, fn) {
  const parts = dotted.split('.')
  const walk = (node, i) => {
    if (node === null || typeof node !== 'object') return
    const key = parts[i]
    const last = i === parts.length - 1
    const keys = key === '*' ? Object.keys(node) : Object.prototype.hasOwnProperty.call(node, key) ? [key] : []
    for (const k of keys) {
      if (last) node[k] = fn(node[k])
      else walk(node[k], i + 1)
    }
  }
  walk(obj, 0)
}

const sortedMultiset = (arr) => (Array.isArray(arr) ? [...arr].map((x) => JSON.stringify(x)).sort().map((s) => JSON.parse(s)) : arr)

/*
 * JSON body rules. `match` receives the request pathname (before the query string).
 * `fn(json)` mutates the (already cloned) body.
 */
const BODY_RULES = [
  {
    match: (p) => p === '/ping' || p === '/ping/',
    why: 'time is Date.now() at request time; commit is the git revision of the running code (old and new apps are different commits by construction); search.* index timestamps/durations/age depend on when each process built its lazy index; search.queryCache hits/misses/cached depend on how concurrent requests interleaved (two identical searches in flight at once are two misses or a miss and a hit, depending on timing) and on what each process has been asked since it started (cached is the number of distinct queries it has memoised, so a server used for earlier probes differs from a fresh one), not on the code',
    fn: (j) => {
      setPath(j, 'time', () => PLACEHOLDER('now'))
      setPath(j, 'commit', () => PLACEHOLDER('revision'))
      setPath(j, 'search.index.builtAt', () => PLACEHOLDER('time'))
      setPath(j, 'search.index.buildMs', () => PLACEHOLDER('ms'))
      setPath(j, 'search.index.ageSeconds', () => PLACEHOLDER('s'))
      setPath(j, 'search.keyword.builtAt', () => PLACEHOLDER('time'))
      setPath(j, 'search.keyword.buildMs', () => PLACEHOLDER('ms'))
      setPath(j, 'search.keyword.ageSeconds', () => PLACEHOLDER('s'))
      setPath(j, 'search.queryCache.hits', () => PLACEHOLDER('count'))
      setPath(j, 'search.queryCache.misses', () => PLACEHOLDER('count'))
      setPath(j, 'search.queryCache.cached', () => PLACEHOLDER('count'))
    },
  },
  {
    match: (p) => p === '/collections' || p === '/collections/',
    why: 'each collection\'s `assets` is shuffleArray(...).slice(0, 15): a random sample of up to 15, different per request, so only its length is comparable',
    fn: (j) => setPath(j, '*.assets', (a) => (Array.isArray(a) ? PLACEHOLDER('random sample of ' + a.length) : a)),
  },
  {
    match: (p) => p === '/vaults' || p === '/vaults/',
    why: 'each vault\'s `assets` is shuffleArray(...) of the full membership: same members, random order, so compare as a sorted multiset',
    fn: (j) => setPath(j, '*.assets', sortedMultiset),
  },
  {
    match: (p) => p === '/v2/create_key' || p === '/v2/create_key/',
    why: 'created_at is the request-time clock and ref is crypto.randomBytes(6): both fresh per request by design',
    fn: (j) => {
      setPath(j, 'data.created_at', () => PLACEHOLDER('time'))
      setPath(j, 'data.ref', () => PLACEHOLDER('random'))
    },
  },
  {
    match: (p) => /^\/v2\/superhive_/.test(p),
    why: 'echoes the stored document: received_at is request-time; req_headers.host carries the instance\'s own port (3001 vs 3002); ip is the caller\'s socket address as the app sees it',
    fn: (j) => {
      setPath(j, 'document.received_at', () => PLACEHOLDER('time'))
      setPath(j, 'document.req_headers.host', () => PLACEHOLDER('host'))
    },
  },
]

// Routes whose JSON object KEY ORDER is itself random (so key order must not be compared there).
const KEY_ORDER_RANDOM = [
  {
    match: (p) => p === '/corporate' || p === '/corporate/',
    why: 'the handler Fisher-Yates shuffles Object.entries(docs) and returns Object.fromEntries: the same sponsors in a random key order on every request',
  },
]

// Express routes are case-insensitive and ignore a trailing slash, so /PING and /ping/ are the same route: match on the folded path.
const fold = (p) => p.toLowerCase()

function normalizeBody(pathname, json) {
  const p = fold(pathname)
  let out = JSON.parse(JSON.stringify(json))
  for (const r of BODY_RULES) if (r.match(p)) r.fn(out)
  return out
}

const keyOrderRandom = (pathname) => KEY_ORDER_RANDOM.some((r) => r.match(fold(pathname)))

/*
 * Routes whose numbers are computed from Date.now() at request time, so floats differ in the last digits between two
 * requests a few milliseconds apart (e.g. 58.58057192286923 vs 58.58057192279175). Numbers there are compared with a
 * relative tolerance; every other value is compared exactly.
 */
const NUMERIC_TOLERANCE = [
  {
    match: (p) => /^\/stats\/(relativecategory|relativetype|taxonomy)\/?$/.test(p),
    rel: 1e-4,
    why: 'relativecategory/relativetype/taxonomy divide by (Date.now()/1000 - date_published) (routes/stats.js), and the two apps are asked minutes apart under load (the first run saw ~2e-6 relative drift in `avg`, the age of a newly published asset moving between the requests), so averages are compared to 1e-4. A real logic difference (a different divisor, a missed asset) moves an average by whole percent, far above that.',
  },
]
const numericTolerance = (pathname) => (NUMERIC_TOLERANCE.find((r) => r.match(fold(pathname))) || { rel: 0 }).rel

/*
 * Live counters that production traffic increments between the old app's request and the new app's. Compared with a
 * small absolute tolerance instead of exactly: download_count (every field of that name, in /assets, /v2/assets,
 * /info and anywhere else) is bumped by real downloads while the run is in progress, so two correct instances can
 * be a few counts apart. A porting error (a missing or doubled count, a wrong asset) is off by far more than this.
 */
const COUNTER_KEYS = { download_count: 5 }

// Walks two normalised bodies of the same shape and, where a counter differs by no more than its tolerance,
// replaces both with the same placeholder so neither the value nor the key-order comparison trips on it.
function alignCounters(a, b) {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return
  for (const k of Object.keys(a)) {
    if (!(k in b)) continue
    const tol = COUNTER_KEYS[k]
    if (tol !== undefined && typeof a[k] === 'number' && typeof b[k] === 'number' && Math.abs(a[k] - b[k]) <= tol) {
      a[k] = b[k] = PLACEHOLDER('live counter')
    } else alignCounters(a[k], b[k])
  }
}

// Routes whose body is non-deterministic after normalisation could still differ by etag between two requests, so a
// 304 round trip is not meaningful there.
const nonDeterministicBody = (pathname) => {
  const p = fold(pathname)
  return BODY_RULES.some((r) => r.match(p)) || KEY_ORDER_RANDOM.some((r) => r.match(p)) || NUMERIC_TOLERANCE.some((r) => r.match(p))
}

/*
 * Text (non-JSON) body rules: [match, regex, replacement, why].
 */
const TEXT_RULES = []

function normalizeText(pathname, text) {
  let out = text
  for (const [match, re, rep] of TEXT_RULES) if (match(pathname)) out = out.replace(re, rep)
  return out
}

/*
 * Recorded Firestore writes / blocked HTTP calls (one record per line from guard.js).
 */
const TIME_KEYS = new Set(['timestamp', 'datetime', 'created_at', 'last_edited', 'received_at'])
// why: all are set from the wall clock inside the handler (new Date().toISOString() / Date.now()).

function normalizeWrite(rec) {
  const r = JSON.parse(JSON.stringify(rec))
  // why: log/, patreon_hooks/ document ids are Date.now() + 3 random digits; api_keys ids are 32 random bytes
  if (typeof r.path === 'string') {
    r.path = r.path
      .replace(/^(log|patreon_hooks)\/\d{13,}$/, '$1/' + PLACEHOLDER('timestamp-id'))
      .replace(/^api_keys\/[0-9a-f]{64}$/, 'api_keys/' + PLACEHOLDER('token'))
  }
  // why: guard_<n> is a per-process counter of add() calls, so it depends on how many ran before, not on the code
  delete r.id
  const walk = (node, inPatronsDoc) => {
    if (node === null || typeof node !== 'object') return
    for (const k of Object.keys(node)) {
      if (TIME_KEYS.has(k) && (typeof node[k] === 'string' || typeof node[k] === 'number')) node[k] = PLACEHOLDER('time')
      else walk(node[k])
    }
  }
  walk(r.data)
  if (r.path && r.path.startsWith('api_keys/') && r.data && r.data.ref) r.data.ref = PLACEHOLDER('random') // why: crypto.randomBytes(6)
  // why: the superhive hook stores the request headers, including host with the instance's own port
  if (r.data && r.data.req_headers && r.data.req_headers.host) r.data.req_headers.host = PLACEHOLDER('host')
  return r
}

module.exports = { alignCounters, numericTolerance, nonDeterministicBody, normalizeBody, normalizeText, normalizeWrite, keyOrderRandom, BODY_RULES, KEY_ORDER_RANDOM, TEXT_RULES }
