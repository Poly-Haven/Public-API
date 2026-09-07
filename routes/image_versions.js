const express = require('express')
const router = express.Router()

const cachedFirestore = require('../utils/cachedFirestore')

// Read through the shared cache so this endpoint costs one Firestore read per node per 10 minutes
// rather than one per request - per-read pricing is a real constraint here, and admin's
// /clear_cache flush already covers this collection.
const db = cachedFirestore()

// Versions for every image that is NOT attached to an asset: site_images/, vaults/, collections/,
// corporate_sponsors/, people/ and misc/. Asset images carry their version on the asset document
// itself (assets/{slug}.img_version) and never appear here.
//
// One document, path -> short content hash, a few hundred entries and a few KB. Written by admin's
// image manager on upload/replace/delete, and rebuildable from Bunny Storage's own per-object
// checksums via its rescan.
const DOC_ID = 'site'

router.get('/', async (req, res) => {
  const doc = await db.collection('image_versions').doc(DOC_ID).get()

  // An empty manifest is a valid answer, not an error: consumers fall back to unversioned URLs,
  // which is exactly the behaviour that predates this endpoint. Returning 404 would instead make
  // every caller special-case it.
  const versions = doc.exists ? doc.data() : {}

  // Must be >= 43200. This zone silently rewrites any shorter max-age up to 43200 and drops
  // s-maxage, so asking for less would be a promise the edge discards. The manifest changes only
  // when someone replaces an image, and that path purges this URL explicitly.
  res.set('Cache-Control', 'public, max-age=43200, s-maxage=43200, stale-while-revalidate=86400')
  res.status(200).json(versions)
})

module.exports = router
