const express = require('express');
const router = express.Router();

const firestore = require('../firestore');

const asset_types = require("../asset_types.json");

const db = firestore();

router.get('/', (req, res) => {
  res.status(400).send(`Please format your request as /categories/[type]`);
});

router.get('/:asset_type', async (req, res) => {
  const asset_type = req.params.asset_type;
  const categories = req.query.in;

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
  let original_categories_arr = [];
  let categories_arr = [];
  if (categories) {
    // Firestore only supports using one 'array-contains' check. So we filter for the last one, and then will manually filter the rest later.
    // TODO Reduce Firestore reads by first getting assets according to least-used category. Will need to separately track which categories are least used, maybe with cloud function.
    original_categories_arr = categories.split(',').map(c => c.trim());
    categories_arr = Array.from(original_categories_arr);  // Deep copy to keep original intact.
    const last_cat = categories_arr.pop();
    collectionRef = collectionRef.where('categories', 'array-contains', last_cat);
  }


  // Get data and convert to an object we can work with further
  const collection = await collectionRef.get();
  let docs = {};
  collection.forEach(doc => {
    docs[doc.id] = doc.data();
  });


  // Categories (2/2)
  // Filter out the remaining assets that aren't in all specifed categories
  for (const cat of categories_arr) {
    for (const id in docs) {
      if (!docs[id].categories.includes(cat)) {
        delete docs[id];
      }
    }
  }


  // Combine and count occurances
  const all_categories = {}
  for (id in docs) {
    for (cat of docs[id].categories) {
      all_categories[cat] = (all_categories[cat] || 0) + 1;
    }
    if (!categories) {
      all_categories['all'] = (all_categories['all'] || 0) + 1;
    }
  }

  for (const cat of original_categories_arr) {
    // We don't need to show the parent counts
    delete all_categories[cat];
  }

  const sorted_cats = Object.entries(all_categories)
    .sort(([, v1], [, v2]) => v2 - v1)
    .reduce((r, [k, v]) => ({ ...r, [k]: v }), {});

  res.status(200).json(sorted_cats);
});

module.exports = router;