const express = require('express');
const router = express.Router();

const firestore = require('../firestore');

const db = firestore();

const popularity = (num, epoch) => {
  return (num + 1) / Math.pow(Math.abs(Date.now() - epoch) + 1, 1.7)
}

router.get('/', async (req, res) => {
  const assetID = req.query.assetID;
  const limit = req.query.limit;

  let collectionRef = db.collection('gallery');

  // Get all renders if request is for a specific asset, otherwise only favourited ones
  if (assetID) {
    collectionRef = collectionRef.where('asset_used', '==', assetID);
  }

  if (parseInt(limit)) {
    // If a limit is requested, we probably only want the best stuff.
    collectionRef = collectionRef.where('favourite', '==', true);
  }

  const collection = await collectionRef.get();
  let docs = {};
  collection.forEach(doc => {
    docs[doc.id] = doc.data();
  });

  // Filter unpublished
  for (const id in docs) {
    if (docs[id].approval_pending) {
      delete docs[id];
    }
  }

  // Sort by popularity
  let sortedKeys = Object.keys(docs).sort(function (a, b) {
    return (popularity(docs[b].clicks, docs[b].date_added) - popularity(docs[a].clicks, docs[a].date_added));
  })
  let data = []
  for (const k of sortedKeys) {
    info = docs[k]
    delete info.id
    delete info.clicks
    delete info.hash
    delete info.software
    delete info.favourite
    delete info.date_added
    info.id = k
    data.push(info)
  }

  data = data.slice(0, parseInt(limit) || 150) // More than this and the browser starts to chug.

  res.status(200).json(data);
});

module.exports = router;