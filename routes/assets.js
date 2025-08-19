const escape = require('escape-html')
const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const asset_types = require('../asset_types.json')

const db = firestore()

// Simple in-memory cache
const cache = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes in milliseconds
const MAX_CACHE_SIZE = 1000 // Maximum number of cache entries
const CLEANUP_INTERVAL = 10 * 60 * 1000 // 10 minutes

let lastCleanup = Date.now()

// Helper function to generate cache key
function getCacheKey(asset_type, categories, includeUpcoming) {
  // Normalize categories by sorting them to ensure consistent keys
  const normalizedCategories = categories
    ? categories
        .split(',')
        .map((c) => c.trim())
        .sort()
        .join(',')
    : 'all'

  return `${asset_type || 'all'}_${normalizedCategories}_${Boolean(includeUpcoming)}`
}

// Helper function to check if cache entry is valid
function isCacheValid(entry) {
  return entry && Date.now() - entry.timestamp < CACHE_TTL
}

// Cleanup expired cache entries to prevent memory leaks
function cleanupExpiredCache() {
  const now = Date.now()
  let removedCount = 0

  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp >= CACHE_TTL) {
      cache.delete(key)
      removedCount++
    }
  }

  // If cache is still too large, remove oldest entries
  if (cache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(cache.entries())
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp)

    const toRemove = cache.size - MAX_CACHE_SIZE
    for (let i = 0; i < toRemove; i++) {
      cache.delete(entries[i][0])
      removedCount++
    }
  }

  if (removedCount > 0) {
    console.log(`[CACHE CLEANUP] Removed ${removedCount} expired entries. Cache size: ${cache.size}`)
  }
}

// Helper function to check if cleanup should run
function shouldCleanup() {
  return Date.now() - lastCleanup > CLEANUP_INTERVAL
}

router.get('/', async (req, res) => {
  const asset_type = req.query.type || req.query.t
  const categories = req.query.categories || req.query.c
  const includeUpcoming = req.query.future

  // Check cache first
  const cacheKey = getCacheKey(asset_type, categories, includeUpcoming)
  let cachedEntry

  try {
    cachedEntry = cache.get(cacheKey)
    if (isCacheValid(cachedEntry)) {
      console.log(`[CACHE HIT] Serving cached data for key: ${cacheKey}`)
      return res.status(200).json(cachedEntry.data)
    }
  } catch (error) {
    console.warn(`[CACHE ERROR] Failed to read cache for key: ${cacheKey}`, error)
  }

  console.log(`[CACHE MISS] Fetching fresh data for key: ${cacheKey}`)

  let collectionRef = db.collection('assets')

  // Type
  if (asset_type in asset_types) {
    const typeIndex = asset_types[asset_type]
    if (typeIndex !== null) {
      collectionRef = collectionRef.where('type', '==', typeIndex)
    }
  } else if (asset_type) {
    res.status(400).send(
      `Unsupported asset type: ${escape(asset_type)}.
      Must be: ${Object.keys(asset_types).join('/')}`
    )
    return
  }

  // Categories (1/2)
  let categories_arr = []
  if (categories) {
    // Firestore only supports using one 'array-contains' check. So we filter for the last one, and then will manually filter the rest later.
    // TODO Reduce Firestore reads by first getting assets according to least-used category. Will need to separately track which categories are least used, maybe with cloud function.
    categories_arr = categories.split(',').map((c) => c.trim())
    const last_cat = categories_arr.pop()
    collectionRef = collectionRef.where('categories', 'array-contains', last_cat)
  }

  // Get data and convert to an object we can work with further
  const collection = await collectionRef.get()
  let docs = {}
  collection.forEach((doc) => {
    docs[doc.id] = doc.data()
  })

  // Filter unpublished
  const now = Math.floor(Date.now() / 1000)
  for (const id in docs) {
    if (docs[id].staging) {
      delete docs[id]
    } else if (!includeUpcoming && docs[id].date_published > now) {
      delete docs[id]
    }
  }

  // Categories (2/2)
  // Filter out the remaining assets that aren't in all specifed categories
  for (const cat of categories_arr) {
    for (const id in docs) {
      if (!docs[id].categories.includes(cat)) {
        delete docs[id]
      }
    }
  }

  // Remove unnecessary data
  const remove_keys = [
    'old_id',
    'reviewers',
    'scale',
    'staging', // It's OK to remove this since we delete truthy staging assets above
  ]
  for (const id in docs) {
    for (const key of remove_keys) {
      delete docs[id][key]
    }
  }

  // Add thumbnail URL
  for (const id in docs) {
    docs[id].thumbnail_url = `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`
  }

  // Cache the result
  try {
    cache.set(cacheKey, {
      data: docs,
      timestamp: Date.now(),
    })
    console.log(`[CACHE STORE] Cached data for key: ${cacheKey} (${Object.keys(docs).length} assets)`)
  } catch (error) {
    console.warn(`[CACHE ERROR] Failed to store cache for key: ${cacheKey}`, error)
  }

  // Only cleanup periodically, not on every request
  if (shouldCleanup()) {
    cleanupExpiredCache()
    lastCleanup = Date.now()
  }

  res.status(200).json(docs)
})

module.exports = router
