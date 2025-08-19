const firestore = require('../firestore')

// Cache for collections
const collectionsCache = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes in milliseconds
const MAX_CACHED_COLLECTIONS = 10 // Limit number of cached collections

// Helper function to check if cache is valid
function isCacheValid(cacheEntry) {
  return cacheEntry && Date.now() - cacheEntry.timestamp < CACHE_TTL
}

// Cleanup expired cache entries
function cleanupExpiredCache() {
  const now = Date.now()
  let removedCount = 0

  for (const [collectionName, cacheEntry] of collectionsCache.entries()) {
    if (now - cacheEntry.timestamp >= CACHE_TTL) {
      collectionsCache.delete(collectionName)
      removedCount++
    }
  }

  // If still too many collections cached, remove oldest ones
  if (collectionsCache.size > MAX_CACHED_COLLECTIONS) {
    const entries = Array.from(collectionsCache.entries())
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp)

    const toRemove = collectionsCache.size - MAX_CACHED_COLLECTIONS
    for (let i = 0; i < toRemove; i++) {
      collectionsCache.delete(entries[i][0])
      removedCount++
    }
  }

  if (removedCount > 0) {
    console.log(
      `[CACHE CLEANUP] Removed ${removedCount} expired collection caches. Active caches: ${collectionsCache.size}`
    )
  }
}

// Run cleanup every 10 minutes
setInterval(cleanupExpiredCache, 10 * 60 * 1000)

// Helper function to check if cache is valid
function isCacheValid(cacheEntry) {
  return cacheEntry && Date.now() - cacheEntry.timestamp < CACHE_TTL
}

// Helper function to get cached collection
async function getCachedCollection(collectionName) {
  const cacheEntry = collectionsCache.get(collectionName)

  if (isCacheValid(cacheEntry)) {
    console.log(`[${collectionName.toUpperCase()} CACHE HIT] Serving cached collection`)
    return cacheEntry.data
  }

  console.log(`[${collectionName.toUpperCase()} CACHE MISS] Fetching fresh collection`)

  const db = firestore()
  const collection = await db.collection(collectionName).get()

  // Convert to the same format as the original code expects
  let docs = {}
  collection.forEach((doc) => {
    docs[doc.id] = doc.data()
  })

  // Cache the result
  collectionsCache.set(collectionName, {
    data: docs,
    timestamp: Date.now(),
  })

  console.log(`[${collectionName.toUpperCase()} CACHE STORE] Cached ${Object.keys(docs).length} documents`)

  return docs
}

// Mock collection reference that applies filters in memory
class CachedCollectionReference {
  constructor(collectionName) {
    this.collectionName = collectionName
    this.filters = []
  }

  where(field, operator, value) {
    this.filters.push({ field, operator, value })
    return this
  }

  async get() {
    // Get the cached data when we actually need it
    const cachedData = await getCachedCollection(this.collectionName)
    let filteredData = { ...cachedData }

    // Apply filters in memory
    for (const filter of this.filters) {
      const { field, operator, value } = filter

      for (const id in filteredData) {
        const doc = filteredData[id]
        let shouldKeep = false

        if (operator === '==') {
          shouldKeep = doc[field] === value
        } else if (operator === 'array-contains') {
          shouldKeep = Array.isArray(doc[field]) && doc[field].includes(value)
        }
        // Add more operators as needed

        if (!shouldKeep) {
          delete filteredData[id]
        }
      }
    }

    // Return a mock collection object that behaves like Firestore's QuerySnapshot
    return {
      forEach: (callback) => {
        for (const [id, data] of Object.entries(filteredData)) {
          callback({
            id: id,
            data: () => data,
          })
        }
      },
    }
  }
}

// Drop-in replacement for firestore that caches collections
function cachedFirestore() {
  const originalDb = firestore()

  return {
    collection: (collectionName) => {
      // Return cached version for any collection
      return {
        get: async () => {
          const cachedData = await getCachedCollection(collectionName)
          return {
            forEach: (callback) => {
              for (const [id, data] of Object.entries(cachedData)) {
                callback({
                  id: id,
                  data: () => data,
                })
              }
            },
          }
        },
        where: (field, operator, value) => {
          const cachedRef = new CachedCollectionReference(collectionName)
          return cachedRef.where(field, operator, value)
        },
      }
    },
    // Proxy other methods to original firestore if needed
    ...originalDb,
  }
}

module.exports = cachedFirestore
