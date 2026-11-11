const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const db = firestore()

const popularity = (num, epoch) => {
  return (num + 1) / Math.pow(Math.abs(Date.now() - epoch) + 1, 1.7)
}

// What a render looks like publicly. Takes the doc's data and strips everything staff-only.
const publicRender = (id, data) => {
  const info = { ...data }
  delete info.id
  delete info.clicks
  delete info.hash
  delete info.software
  delete info.favourite
  delete info.date_added
  delete info.reviewed_by
  delete info.author_email
  // The submitter's own AI disclosure, before review. The reviewer's version (ai_use, ai_note) is the public one.
  delete info.ai_use_submitted
  delete info.ai_note_submitted
  info.id = id
  return info
}

const clampInt = (value, fallback, max) => {
  const n = parseInt(value)
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback
}

router.get('/', async (req, res) => {
  const assetID = req.query.assetID
  const limit = req.query.limit

  let collectionRef = db.collection('gallery')

  // Get all renders if request is for a specific asset, otherwise only favourited ones
  if (assetID) {
    collectionRef = collectionRef.where('assets_used', 'array-contains', assetID)
  }

  if (parseInt(limit)) {
    // If a limit is requested, we probably only want the best stuff.
    collectionRef = collectionRef.where('favourite', '==', true)
  }

  const collection = await collectionRef.get()
  let docs = {}
  collection.forEach((doc) => {
    docs[doc.id] = doc.data()
  })

  // Filter unpublished
  for (const id in docs) {
    if (docs[id].approval_pending) {
      delete docs[id]
    }
  }

  // Sort by popularity
  let sortedKeys = Object.keys(docs).sort(function (a, b) {
    return popularity(docs[b].clicks, docs[b].date_added) - popularity(docs[a].clicks, docs[a].date_added)
  })
  let data = sortedKeys.map((k) => publicRender(k, docs[k]))

  data = data.slice(0, parseInt(limit) || 150) // More than this and the browser starts to chug.

  res.status(200).json(data)
})

// The first screen of polyhaven.com/gallery: the most popular renders, plus the cursor that
// /gallery/feed continues from.
//
// `next` skips the run of newest renders that are already in `items`, so the feed starts with the
// first render the visitor hasn't seen. It is always a number (one past the newest render when
// that render isn't in `items`), so the site never asks for an uncursored feed page. An approval
// changes this response, which admin purges, and so moves the site onto new feed URLs rather than
// invalidating cached ones. Only a deletion changes an existing feed page.
//
// Reads the whole collection, like `/`. admin purges this URL on approval.
router.get('/top', async (req, res) => {
  const limit = clampInt(req.query.limit, 60, 150)

  const collection = await db.collection('gallery').get()
  const docs = []
  collection.forEach((doc) => {
    const d = doc.data()
    if (!d.approval_pending) docs.push({ id: doc.id, data: d })
  })

  docs.sort((a, b) => popularity(b.data.clicks, b.data.date_added) - popularity(a.data.clicks, a.data.date_added))
  const top = docs.slice(0, limit)
  const inTop = new Set(top.map((d) => d.id))

  const newestFirst = docs.slice().sort((a, b) => b.data.date_added - a.data.date_added)
  let next = newestFirst.length ? newestFirst[0].data.date_added + 1 : null
  for (const d of newestFirst) {
    if (!inTop.has(d.id)) break
    next = d.data.date_added
  }
  if (next !== null && inTop.size === docs.length) next = null // everything is already in `items`

  res.status(200).json({ items: top.map((d) => publicRender(d.id, d.data)), next })
})

// Every approved render, newest approval first (`date_added` is set at approval), a page at a time.
//
// GET /gallery/feed?before=<date_added>&limit=48 -> { items, next }
// `next` is the `before` for the following page, or null after the last one.
//
// The cursor is a value rather than a document, so each page's URL is fixed and the edge caches
// it: there are only ~40 pages for the whole archive. Pending renders are in the same collection,
// interleaved by submission time, so a few extra docs are read and the pending ones dropped. That
// avoids a composite index for what is, at any moment, a handful of documents.
const FEED_SLACK = 10
router.get('/feed', async (req, res) => {
  const limit = clampInt(req.query.limit, 48, 100)
  const before = req.query.before !== undefined ? Number(req.query.before) : null
  if (before !== null && !Number.isFinite(before)) {
    res.set('Cache-Control', 'no-store')
    res.status(400).json({ error: '400 Bad Request', message: '`before` must be a number' })
    return
  }

  let query = db.collection('gallery').orderBy('date_added', 'desc')
  if (before !== null) query = query.startAfter(before)
  const scanned = []
  ;(await query.limit(limit + FEED_SLACK).get()).forEach((doc) => scanned.push({ id: doc.id, data: doc.data() }))

  const approved = scanned.filter((d) => !d.data.approval_pending)
  let items, next
  if (approved.length > limit) {
    items = approved.slice(0, limit)
    next = items[items.length - 1].data.date_added
  } else {
    items = approved
    // A full scan means there may be more; a short one means this was the end.
    next = scanned.length === limit + FEED_SLACK ? scanned[scanned.length - 1].data.date_added : null
  }

  res.status(200).json({ items: items.map((d) => publicRender(d.id, d.data)), next })
})

// One render, for a ?render=<id> link to a render that isn't on the first screen.
router.get('/render/:id', async (req, res) => {
  // Uncacheable unless found: a render that's still pending would otherwise be a cached 404
  // after it's approved.
  res.set('Cache-Control', 'no-store')
  const doc = await db.collection('gallery').doc(String(req.params.id)).get()
  if (!doc.exists || doc.data().approval_pending) {
    res.status(404).json({ error: '404 Not Found', message: 'No such render' })
    return
  }
  res.removeHeader('Cache-Control')
  res.status(200).json(publicRender(doc.id, doc.data()))
})

module.exports = router
