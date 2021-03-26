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


  // Type
  if (asset_type in asset_types) {
    collectionRef = collectionRef.where('type', '==', asset_types[asset_type]);
  } else if (asset_type) {
    res.status(400).send(
      `Unsupported asset type: ${asset_type}.
      Must be: ${Object.keys(asset_types).join('/')}`);
    return;
  }


  // Categories (1/2)
  let categories_arr = [];
  if (categories) {
    // Firestore only supports using one 'array-contains' check. So we filter for the last one, and then will manually filter the rest later.
    // TODO Reduce Firestore reads by first getting assets according to least-used category. Will need to separately track which categories are least used, maybe with cloud function.
    categories_arr = categories.split(',').map(c => c.trim());
    const last_cat = categories_arr.pop();
    collectionRef = collectionRef.where('categories', 'array-contains', last_cat);
  }


  // Author
  if (author) {
    collectionRef = collectionRef.where(`authors.${author}`, '>=', "");
  }


  // Get data and conver to an object we can work with further
  const collection = await collectionRef.get();
  const docs = {};
  collection.forEach(doc => {
    docs[doc.id] = doc.data();
  });


  // Categories (2/2)
  // Filter out the remaining assets that aren't in all specifed categories
  console.log(categories_arr);
  for (const cat of categories_arr) {
    for (const id in docs) {
      if (!docs[id].categories.includes(cat)) {
        delete docs[id];
      }
    }
  }

  res.status(200).json(docs);
});

module.exports = router;