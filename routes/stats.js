const express = require('express');
const router = express.Router();

const firestore = require('../firestore');

const db = firestore();

router.get('/downloads', async (req, res) => {
  const slug = req.query.slug;
  const type = req.query.type;
  const date_from = req.query.date_from;
  const date_to = req.query.date_to;

  let collectionRef = db.collection('downloads_daily');

  collectionRef = slug ? collectionRef.where('slug', '==', slug) : collectionRef
  collectionRef = type ? collectionRef.where('type', '==', type) : collectionRef
  collectionRef = date_from ? collectionRef.where('day', '>=', date_from) : collectionRef
  collectionRef = date_to ? collectionRef.where('day', '<=', date_to) : collectionRef

  const collection = await collectionRef.get();
  let docs = [];
  collection.forEach(doc => {
    docs.push(doc.data());
  });

  res.status(200).json(docs);
});

module.exports = router;