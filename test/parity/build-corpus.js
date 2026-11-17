'use strict'
/*
 * Builds the replay corpus from production-log counts.
 *   node build-corpus.js <counted.txt> <out corpus.json>
 * Input lines: "<count> <METHOD> <URL>". Deterministic (no randomness; ties broken by URL).
 * Output: [{method, url, headers?, auth?, tag}]   auth is one of "none" | "unknown" | "ea" | "plain" (v2 key variants, resolved by diff.js).
 * The output contains real user search queries: keep it out of version control.
 */
const fs = require('fs')

const [, , inFile, outFile] = process.argv
if (!inFile || !outFile) {
  console.error('usage: node build-corpus.js <counted.txt> <corpus.json>')
  process.exit(2)
}

// First path segments that are real routes in the app (routes/*.js, routes/v2, plus app.js's own).
const KNOWN = new Set(
  'assets author authors bl_repo categories clear_cache collections community_prizes corporate course_progress courses dl_track extensions files finances funding gallery gallery_click image_versions info legacy lighthouse_key milestones news patreon_hook patron_info patrons patrons_latest patrons_top ping popularity renders rss search similar sponsor stats taxonomy text timelines track_search translation_progress types vaults v2 api-docs debug llms.txt openapi.json hdris textures models hdris-simple textures-simple models-simple'.split(
    ' '
  )
)
const SMALL_GROUPS = new Set(['stats', 'popularity']) // expensive routes: 15 each
const PER_GROUP = 60
const TOP = 20
const MAX_URL = 2000

const lines = fs.readFileSync(inFile, 'utf8').split(/\r?\n/).filter(Boolean)
const rows = []
for (const l of lines) {
  const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l)
  if (!m) continue
  rows.push({ count: +m[1], method: m[2].toUpperCase(), url: m[3] })
}

const seg = (url) =>
  url
    .split('?')[0]
    .split('/')
    .filter((x, i) => i > 0 || x !== '')
const group = (url) => {
  const s = seg(url)[0]
  return s === undefined ? '' : s
}
const keySet = (url) => {
  const q = url.split('?')[1]
  if (!q) return ''
  return q
    .split('&')
    .map((p) => p.split('=')[0])
    .sort()
    .join(',')
}
const second = (url) => seg(url)[1] || ''
const byCount = (a, b) => b.count - a.count || (a.url < b.url ? -1 : 1)

// Never replay the superhive webhook path (it embeds a secret) or absurdly long lines.
const usable = rows.filter((r) => !r.url.includes('superhive_') && r.url.length <= MAX_URL && r.url.startsWith('/'))

function pickGroup(list, limit) {
  const sorted = [...list].sort(byCount)
  const picked = sorted.slice(0, Math.min(TOP, limit))
  const seen = new Set(picked.map((r) => r.url))
  const keys = new Set(picked.map((r) => keySet(r.url)))
  const seconds = new Set(picked.map((r) => second(r.url)))
  const rest = sorted.filter((r) => !seen.has(r.url))
  // Greedy: prefer an unseen query key set (weight 2) and an unseen second segment (weight 1).
  while (picked.length < limit && rest.length) {
    let best = -1
    let bestScore = -1
    for (let i = 0; i < rest.length; i++) {
      const s = (keys.has(keySet(rest[i].url)) ? 0 : 2) + (seconds.has(second(rest[i].url)) ? 0 : 1)
      if (s > bestScore) {
        bestScore = s
        best = i
        if (s === 3) break
      }
    }
    const r = rest.splice(best, 1)[0]
    picked.push(r)
    keys.add(keySet(r.url))
    seconds.add(second(r.url))
  }
  return picked
}

const out = []
const stats = {}
const seenKey = new Set()
const add = (e, bucket) => {
  const k = e.method + ' ' + e.url + ' ' + (e.auth || '') + JSON.stringify(e.headers || {})
  if (seenKey.has(k)) return
  seenKey.add(k)
  out.push(e)
  stats[bucket] = (stats[bucket] || 0) + 1
}

const getRows = usable.filter((r) => r.method === 'GET')
const headRows = usable.filter((r) => r.method === 'HEAD')
const optRows = usable.filter((r) => r.method === 'OPTIONS')

const groups = new Map()
for (const r of getRows) {
  const g = group(r.url)
  if (!KNOWN.has(g) && g !== '') continue // scanner junk handled below
  if (!groups.has(g)) groups.set(g, [])
  groups.get(g).push(r)
}

const bucketName = (g) => '/' + g
for (const g of [...groups.keys()].sort()) {
  const list = groups.get(g)
  if (g === 'v2') {
    // few and all distinct: keep them all, with each key variant
    for (const r of list.sort(byCount))
      for (const auth of ['none', 'unknown', 'ea', 'plain'])
        add({ method: 'GET', url: r.url, auth, tag: 'v2' }, bucketName(g))
    continue
  }
  const limit = SMALL_GROUPS.has(g) ? 15 : PER_GROUP
  for (const r of pickGroup(list, limit)) add({ method: 'GET', url: r.url, tag: 'log' }, bucketName(g))
}

// HEAD (all that are real routes), OPTIONS (preflight): up to 8 per group.
for (const r of headRows)
  if (KNOWN.has(group(r.url)) || group(r.url) === '') add({ method: 'HEAD', url: r.url, tag: 'head' }, 'HEAD')
const optByGroup = new Map()
for (const r of optRows) {
  const g = group(r.url)
  if (!KNOWN.has(g) && g !== '') continue
  if (!optByGroup.has(g)) optByGroup.set(g, [])
  optByGroup.get(g).push(r)
}
for (const g of [...optByGroup.keys()].sort()) {
  for (const r of optByGroup.get(g).sort(byCount).slice(0, 8)) {
    add(
      {
        method: 'OPTIONS',
        url: r.url,
        headers: {
          origin: 'https://polyhaven.com',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization,content-type',
        },
        tag: 'preflight',
      },
      'OPTIONS'
    )
  }
}
// A preflight for a POST route, and a preflight with no requested headers.
add(
  {
    method: 'OPTIONS',
    url: '/patron_info',
    headers: {
      origin: 'https://polyhaven.com',
      'access-control-request-method': 'PATCH',
      'access-control-request-headers': 'content-type',
    },
    tag: 'preflight',
  },
  'OPTIONS'
)
add(
  {
    method: 'OPTIONS',
    url: '/assets?t=hdris',
    headers: { origin: 'https://example.org', 'access-control-request-method': 'GET' },
    tag: 'preflight',
  },
  'OPTIONS'
)
add({ method: 'GET', url: '/assets?t=hdris', headers: { origin: 'https://example.org' }, tag: 'cors' }, 'cors-get')

// Junk / scanner URLs: one most-frequent URL per distinct unknown first segment, up to 40.
const junkBySeg = new Map()
for (const r of getRows.sort(byCount)) {
  const g = group(r.url)
  if (KNOWN.has(g) || g === '') continue
  if (!junkBySeg.has(g)) junkBySeg.set(g, r)
}
const junk = [...junkBySeg.values()].sort(byCount).slice(0, 40)
for (const r of junk) add({ method: 'GET', url: r.url, tag: 'junk' }, 'junk')

// Hand-written edge cases.
const longQuery = '/assets?' + Array.from({ length: 200 }, (_, i) => 'k' + i + '=' + 'v'.repeat(20)).join('&')
const edges = [
  '/',
  '/llms.txt',
  '/openapi.json',
  '/api-docs/swagger.json',
  '/v2/superhive_wrong',
  '/v2/superhive_wrong/',
  '/assets/',
  '/Assets',
  '/ASSETS?t=hdris',
  '/info/Abandoned_Factory_Canteen_01',
  '/info/',
  '//assets',
  '///info/x',
  '/assets//',
  '/info/%E0%A4%A',
  '/info/%',
  '/assets?t=%E0%A4%A',
  '/assets?%',
  '/info/%2e%2e/assets',
  '/info/..%2fassets',
  '/info/a%00b',
  '/assets?type[]=hdris',
  '/assets?type=hdris&type=textures',
  '/assets?t=hdris&t=textures',
  '/assets?t[a]=1',
  '/assets?t=',
  '/assets?',
  '/assets?t=hdris&c=',
  '/assets?c=a&c=b',
  '/search?q=a&q=b',
  '/search?q[]=rock',
  '/search?q=',
  '/search',
  '/search?q=rock&limit=-5',
  '/search?q=rock&limit=abc',
  longQuery,
  '/search?q=' + 'x'.repeat(600),
  '/info/' + 'a'.repeat(1500),
  '/files/' + 'a'.repeat(300),
  '/ping/',
  '/ping?x=1',
  '/PING',
  '/types',
  '/types/',
  '/categories/hdris',
  '/categories/nonexistent',
  '/info/nonexistent_asset_zz',
  '/files/nonexistent_asset_zz',
  '/author/nonexistent_zz',
  '/sponsor',
  '/sponsor/',
  '/sponsor/nonexistent_zz',
  '/sponsor/corp_nonexistent_zz',
  '/rss',
  '/rss?x=1',
  '/stats/nonexistent',
  '/popularity/2099-01',
  '/popularity/notamonth',
  '/gallery/render/nonexistent_zz',
  '/renders/nonexistent_zz',
  '/similar/nonexistent_zz',
  '/courses/nonexistent_zz',
  '/timelines/nonexistent_zz',
  '/text/nonexistent_zz',
  '/taxonomy/nonexistent',
  '/bl_repo/',
  '/bl_repo/index.json',
  '/bl_repo/nonexistent',
  '/clear_cache',
  '/dl_track',
  '/patron_info',
  '/lighthouse_key',
  '/lighthouse_key/open',
  '/tmp',
  '/api-docs',
  '/api-docs/',
  '/debug/on',
  '/v2',
  '/v2/',
  '/v2/assets',
  '/v2/files/nonexistent_zz',
]
for (const u of edges) add({ method: 'GET', url: u, tag: 'edge' }, 'edge')
add({ method: 'HEAD', url: '/assets?t=hdris', tag: 'edge' }, 'edge')
add({ method: 'HEAD', url: '/nonexistent', tag: 'edge' }, 'edge')
add({ method: 'HEAD', url: '/', tag: 'edge' }, 'edge')
add({ method: 'GET', url: '/assets?t=hdris', headers: { 'accept-encoding': 'gzip' }, tag: 'edge' }, 'edge')
add({ method: 'GET', url: '/assets?t=hdris', headers: { 'accept-encoding': 'br' }, tag: 'edge' }, 'edge')
// Not a GET/HEAD/OPTIONS: unsupported methods on a read route must 404 identically.
add({ method: 'DELETE', url: '/assets', tag: 'edge' }, 'edge')
add({ method: 'PUT', url: '/info/x', tag: 'edge' }, 'edge')
add({ method: 'POST', url: '/assets', tag: 'edge' }, 'edge')
add({ method: 'POST', url: '/ping', tag: 'edge' }, 'edge')
add({ method: 'PATCH', url: '/types', tag: 'edge' }, 'edge')

fs.writeFileSync(outFile, JSON.stringify(out, null, 0))
const lines2 = Object.keys(stats)
  .sort()
  .map((k) => k.padEnd(28) + stats[k])
lines2.push('TOTAL'.padEnd(28) + out.length)
fs.writeFileSync(outFile.replace(/\.json$/, '.stats.txt'), lines2.join('\n') + '\n')
console.log(lines2.join('\n'))
