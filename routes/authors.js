const express = require('express');
const router = express.Router();

const firestore = require('../firestore');

const db = firestore();

router.get('/', async (req, res) => {

  const colAssets = await db.collection('assets').get();
  const assets = {};
  colAssets.forEach(doc => {
    assets[doc.id] = doc.data();
  });

  const assetCounts = {};
  for (const asset of Object.values(assets)) {
    for (const author of Object.keys(asset.authors)) {
      if (assetCounts[author]) {
        assetCounts[author]++;
      } else {
        assetCounts[author] = 1;
      }
    }
  }

  const colAuthors = await db.collection('authors').get();
  const authors = {};
  colAuthors.forEach(doc => {
    const ac = assetCounts[doc.id] || 0;
    if (ac !== 0) {
      authors[doc.id] = doc.data();
      authors[doc.id].assetCount = assetCounts[doc.id] || 0;
    }
  });

  res.status(200).json(authors);
});

module.exports = router;