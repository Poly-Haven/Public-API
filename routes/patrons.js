const express = require('express');
const router = express.Router();

const firestore = require('../firestore');

router.get('/', async (req, res) => {
  const db = firestore();
  const collection = await db.collection('patrons').where('status', '==', 'active_patron').get();
  let data = {};
  collection.forEach(doc => {
    data[doc.id] = doc.data();
  });

  const sortedKeys = Object.keys(data).sort((a, b) => data[a].joined.localeCompare(data[b].joined))

  let patrons = [];
  for (const p of sortedKeys) {
    if (!data[p].anon) {
      patrons.push([data[p].display_name || data[p].name, data[p].rank])
    }
  }

  res.status(200).json(patrons)
});

module.exports = router;
