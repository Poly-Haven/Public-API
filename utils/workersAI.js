require('dotenv').config()
// node-fetch rather than global fetch: the api nodes run Node 15, where `fetch` is undefined,
// so every /search would have 503'd on `fetch is not defined`. routes/rss.js and
// routes/stats.js already require it the same way.
const fetch = require('node-fetch')

/**
 * Cloudflare Workers AI, query side only. See admin's utils/workersAI.ts for the generation side
 * and plans/semantic_search.md for the full story. Two things that are easy to get wrong:
 *
 *  - The `instruction` parameter Cloudflare's model docs describe is SILENTLY IGNORED when passed
 *    alongside `text` - the returned vector is bit-identical to the unprefixed one. The only way to
 *    instruct a query is to write qwen3's own template into the text, which is what asQuery does.
 *  - The instruction WORDING is the biggest measured quality lever: naming our domain scores 0.622
 *    multilingual overlap@10, Cloudflare's generic phrasing scores 0.470 - worse than sending no
 *    instruction at all (0.529). It must stay identical to admin's copy, or queries and documents
 *    land in different parts of the space.
 */

const MODEL = '@cf/qwen/qwen3-embedding-0.6b'
const DIMS = 1024
const QUERY_INSTRUCTION = 'Given a search query, retrieve relevant 3D assets, textures and HDRI environment maps'

const TIMEOUT_MS = 8000 // a user is waiting on this one
const MAX_ATTEMPTS = 2

const asQuery = (query) => `Instruct: ${QUERY_INSTRUCTION}\nQuery: ${query}`

// Zipfian queries mean a small cache absorbs most of the traffic that gets past the edge. Per node,
// so a two-node fleet halves the hit rate - still worth it.
const CACHE_MAX = 2000
const cache = new Map()

const cacheStats = { hits: 0, misses: 0 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Embed a search query. Returns a normalised Float32Array, or throws.
 * `query` must already be normalised by the caller (trimmed, lowercased) so the cache key and the
 * edge cache key agree.
 */
const embedQuery = async (query) => {
  const hit = cache.get(query)
  if (hit) {
    cacheStats.hits++
    // Refresh recency: re-inserting moves it to the end of the Map's iteration order.
    cache.delete(query)
    cache.set(query, hit)
    return hit
  }
  cacheStats.misses++

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_AI_TOKEN
  if (!accountId) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set')
  if (!token) throw new Error('CLOUDFLARE_AI_TOKEN is not set')

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`
  let lastError

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: asQuery(query) }),
        signal: controller.signal,
      })
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Workers AI HTTP ${res.status}`)
      } else {
        const json = await res.json()
        if (!json.success) throw new Error(`Workers AI error ${res.status}: ${JSON.stringify(json.errors)}`)
        const raw = json.result && json.result.data && json.result.data[0]
        if (!raw || raw.length !== DIMS) throw new Error(`Workers AI returned ${raw && raw.length} dims`)

        // Normalise once here, so scoring is a plain dot product against the index's inverse norms.
        let sum = 0
        for (let i = 0; i < DIMS; i++) sum += raw[i] * raw[i]
        const norm = Math.sqrt(sum) || 1
        const vector = new Float32Array(DIMS)
        for (let i = 0; i < DIMS; i++) vector[i] = raw[i] / norm

        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
        cache.set(query, vector)
        return vector
      }
    } catch (err) {
      if (err.name === 'AbortError') lastError = new Error(`Workers AI timed out after ${TIMEOUT_MS}ms`)
      else if (!/HTTP (429|5\d\d)/.test(err.message)) throw err
      else lastError = err
    } finally {
      clearTimeout(timer)
    }
    if (attempt < MAX_ATTEMPTS - 1) await sleep(400)
  }

  throw lastError || new Error('Workers AI: retries exhausted')
}

const stats = () => ({ ...cacheStats, cached: cache.size })

module.exports = { embedQuery, asQuery, stats, MODEL, DIMS }
