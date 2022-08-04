const express = require('express');
const router = express.Router();

const firestore = require('../firestore');

const db = firestore();

router.get('/', async (req, res) => {
  const now = new Date().toISOString()
  const collection = await db.collection('news').where("date_end", ">=", now).get();
  let docs = [];
  collection.forEach(doc => {
    let data = doc.data()
    if (data.date_start <= now) {
      if (data.active) {
        data.key = doc.id
        docs.push(data)
      }
    }
  });
  res.status(200).json(docs);
});

module.exports = router;