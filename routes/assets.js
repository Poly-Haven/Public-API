const express = require('express');
const router = express.Router();

const firestore = require('../firestore');

const asset_types = {
  "hdris": 0,
  "textures": 1,
  "models": 2
}

const db = firestore();

router.get('/', async (req, res) => {
  const asset_type = req.query.type || req.query.t;
  const categories = req.query.categories || req.query.c;
  const search = req.query.search || req.query.s;
  const author = req.query.author || req.query.a;
  const sort = req.query.sort || req.query.o;

  let collectionRef = db.collection('assets');

  if (asset_type in asset_types){
    collectionRef = collectionRef.where('type', '==', asset_types[asset_type]);
  }else if(asset_type){
    res.status(400).send(
      `Unsupported asset type: ${asset_type}.
      Must be: ${Object.keys(asset_types).join('/')}`);
    return;
  }

  const collection = await collectionRef.get();
  const docs = {};
  collection.forEach(doc => {
    docs[doc.id] = doc.data();
  });

  res.status(200).json(docs);
});

module.exports = router;