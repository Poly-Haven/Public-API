import FuseModule from 'fuse.js'
import type { Asset } from '../types/firestore.ts'
import cachedFirestore from './cachedFirestore.ts'

/**
 * The keyword half of hybrid search.
 *
 * Deliberately the same engine and the same config polyhaven.com's Grid.tsx has always used, so the
 * keyword lane behaves exactly like the search it is being fused with. Changing these options
 * changes what "keyword match" means for every consumer of /search, not just the website.
 *
 * Its job is not to rank results on its own - the semantic lane does the heavy lifting - but to
 * corroborate. An asset both lanes like beats one only the vectors liked, which is what stops
 * `rocky_terrain_02` sitting fifth for "grass" and what lifts an asset's own name variants.
 */

interface KeywordDoc {
  name: string
  tags: string[]
  categories: string[]
}
// fuse.js 6 ships ES-style typings (`export default`) on a CommonJS build, so under Node ESM the default import
// is the class itself while TypeScript sees a module object with a `default`. Describing the slice used here
// avoids a cast per call. (Kept on 6.x: 7.x scores differently and reordered /search results.)
interface KeywordFuse {
  search(pattern: string): { refIndex: number }[]
}
const Fuse = FuseModule as unknown as new (docs: KeywordDoc[], options: typeof FUSE_OPTIONS) => KeywordFuse

interface KeywordIndex {
  fuse: KeywordFuse
  slugs: string[]
  count: number
  builtAt: number
  buildMs: number
}

const FUSE_OPTIONS = {
  keys: ['categories', 'tags', 'name'],
  includeScore: true,
  useExtendedSearch: true,
  threshold: 0.2,
}

// Long, like the vector index: the content only changes on publish, and admin's /clear_cache
// fan-out invalidates both. A short TTL only bought a ~2.8s rebuild in some unlucky user's request.
const TTL = 6 * 60 * 60 * 1000

const db = cachedFirestore()

let index: KeywordIndex | null = null
let building: Promise<KeywordIndex> | null = null

const buildIndex = async (): Promise<KeywordIndex> => {
  const startedAt = Date.now()
  const collection = await db.collection<Asset>('assets').get()
  const slugs: string[] = []
  const docs: KeywordDoc[] = []
  collection.forEach((doc) => {
    const asset = doc.data()
    slugs.push(doc.id)
    // Only the fields Fuse indexes, so the index does not pin a second copy of every asset in
    // memory. `name` is included as-is, and slug matching is handled separately by the exact pin.
    docs.push({
      name: asset.name || '',
      tags: asset.tags || [],
      categories: asset.categories || [],
    })
  })
  const built = {
    fuse: new Fuse(docs, FUSE_OPTIONS),
    slugs,
    count: slugs.length,
    builtAt: Date.now(),
    buildMs: Date.now() - startedAt,
  }
  console.log(`[KEYWORD INDEX] built over ${built.count} assets in ${built.buildMs}ms`)
  return built
}

const isFresh = () => index && Date.now() - index.builtAt < TTL

const getIndex = async (): Promise<KeywordIndex> => {
  if (index && isFresh()) return index
  if (building) return building
  building = (async () => {
    try {
      index = await buildIndex()
      return index
    } finally {
      building = null
    }
  })()
  return building
}

cachedFirestore.onClear(() => {
  index = null
})

// Build shortly after boot rather than inside the first search. This is a timer, not an awaited
// startup step, so a slow or failed read never delays listen() - it just means the first search builds it.
setTimeout(() => {
  getIndex().catch((err) => console.error('[KEYWORD INDEX] warm-up failed:', err.message))
}, 10000).unref?.()

/**
 * Fuse's extended-search syntax, applied the way the website has always applied it: a space means
 * OR, a plus means AND. The other operators (^ ! = $ ') are stripped rather than honoured - the
 * website never intended to expose them, and on a public endpoint a stray one is either a parse
 * error or a surprise.
 */
const toExtendedQuery = (query: string) =>
  String(query)
    .replace(/[\^!=$']/g, '')
    .trim()
    .replace(/\s+/g, '|')
    .replace(/\+/g, ' ')

/**
 * Slugs in keyword-relevance order, best first. Never throws: a query Fuse cannot parse means no
 * keyword opinion, which degrades hybrid search to pure semantic rather than failing the request.
 */
const rank = async (query: string): Promise<string[]> => {
  const extended = toExtendedQuery(query)
  if (!extended) return []
  const idx = await getIndex()
  try {
    return idx.fuse.search(extended).map((hit) => idx.slugs[hit.refIndex])
  } catch (err) {
    console.error('[KEYWORD INDEX] search failed for', JSON.stringify(extended), (err as Error).message)
    return []
  }
}

const stats = () => {
  if (!index) return { built: false }
  return {
    built: true,
    assets: index.count,
    builtAt: new Date(index.builtAt).toISOString(),
    buildMs: index.buildMs,
    ageSeconds: Math.round((Date.now() - index.builtAt) / 1000),
    fresh: isFresh(),
  }
}

export { rank, stats, toExtendedQuery, FUSE_OPTIONS }
