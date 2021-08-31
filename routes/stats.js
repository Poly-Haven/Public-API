const express = require('express');
const router = express.Router();

const firestore = require('../firestore');

const db = firestore();


const assetsPublishedInDateRange = async (date_from, date_to) => {
  const epoch_end = Date.parse(`${date_to}T23:59:59Z`) / 1000
  const collection = await db
    .collection("assets")
    .where("date_published", "<=", epoch_end)
    .get();

  let assets = [];
  collection.forEach(doc => {
    assets.push(doc.data());
  });

  const oneDay = 24 * 60 * 60
  let epoch = (Date.parse(`${date_from}T23:59:59Z`) / 1000) - oneDay
  let days = {}
  while (epoch < epoch_end) {
    epoch += oneDay
    const day = new Date(epoch * 1000).toISOString().split('T')[0]
    days[day] = days[day] || {
      hdris: 0,
      textures: 0,
      models: 0,
    }
    for (const asset of assets) {
      if (asset.date_published <= epoch) {
        const type = Object.keys(days[day])[asset.type]
        days[day][type]++;
      }
    }
  }

  return days
}


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


router.get('/relativetype', async (req, res) => {
  const date_from = req.query.date_from;
  const date_to = req.query.date_to;

  let collectionRef = db.collection('downloads_daily');

  const types = {
    T0: "hdris",
    T1: "textures",
    T2: "models",
  }

  collectionRef = collectionRef.where('type', '==', 'TYPE')
  collectionRef = collectionRef.where('slug', 'in', Object.keys(types))
  collectionRef = date_from ? collectionRef.where('day', '>=', date_from) : collectionRef
  collectionRef = date_to ? collectionRef.where('day', '<=', date_to) : collectionRef

  const collection = await collectionRef.get();
  let stats = {};
  collection.forEach(doc => {
    stats[doc.id] = doc.data()
  });

  const assetsPublished = await assetsPublishedInDateRange(date_from, date_to)

  let returnData = {}
  for (const [day, nums] of Object.entries(assetsPublished)) {
    let downloadsPerAsset = {}
    let total = 0
    for (const [k, type] of Object.entries(types)) {
      if (!stats[`${day}_${k}`]) continue
      const downloadsPer = stats[`${day}_${k}`].unique / nums[type]
      downloadsPerAsset[type] = downloadsPer
      total += downloadsPer
    }
    let relative = {}
    for (const [type, value] of Object.entries(downloadsPerAsset)) {
      relative[type] = value / total * 100
    }
    if (Object.keys(relative).length) {
      returnData[day] = relative
    }
  }

  res.status(200).json(returnData);

});

module.exports = router;