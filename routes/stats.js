const express = require('express');
const fetch = require("node-fetch");
const router = express.Router();
const subMonths = require("date-fns/subMonths")

require('dotenv').config()

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


router.get('/relativecategory', async (req, res) => {

  let collectionRef = db.collection('assets');

  const collection = await collectionRef.get();
  let assets = {};
  collection.forEach(doc => {
    assets[doc.id] = doc.data()
  });

  const types = [
    "hdris",
    "textures",
    "models",
  ]

  const returnData = {
    hdris: {},
    textures: {},
    models: {},
  }

  // First store all downloads/day per asset with each cat
  for (const asset of Object.values(assets)) {
    for (const cat of asset.categories) {
      const t = types[asset.type]
      const secondsPublished = Date.now() / 1000 - asset.date_published
      const daysPublished = secondsPublished / 24 / 60 / 60
      if (daysPublished < 1) continue
      const downloadsPerDay = asset.download_count / daysPublished
      returnData[t][cat] = returnData[t][cat] || []
      returnData[t][cat].push(downloadsPerDay);
    }
  }

  // Then average the downloads/day for each cat
  const average = (array) => array.reduce((a, b) => a + b) / array.length;
  for (const [t, typeData] of Object.entries(returnData)) {
    for (const [c, data] of Object.entries(typeData)) {
      returnData[t][c] = { count: data.length, avg: average(data) }
    }
  }

  res.status(200).json(returnData);
});


router.get('/cfmonth', async (req, res) => {
  // pageViews and bandwidth data for the previous month

  const isoDay = date => date.toISOString().substring(0, 10) // YYYY-MM-DD

  const now = Date.now()
  const toDate = isoDay(new Date(now))
  const fromDate = isoDay(subMonths(now, 1))

  const zones = [
    process.env.CLOUDFLARE_ZONE,
    process.env.CLOUDFLARE_ZONE_ORG,
  ]

  let pageViews = 0
  let bytes = 0
  let users = 0

  for (const zone of zones) {
    const query = `
    {
    viewer {
      zones(filter: {zoneTag: "${zone}"}) {
        httpRequests1dGroups(
          orderBy: [date_ASC],
          limit: 1000,
          filter: {
            date_geq: "${fromDate}",
            date_lt: "${toDate}",
          }
        ) {
          date: dimensions {
            date
          }
          sum {
            pageViews
            bytes
          }
          uniq {
            uniques
          }
        }
      }
    }
  }
  `
    const result = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AUTH-EMAIL': process.env.CLOUDFLARE_API_EMAIL,
        authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      },
      body: JSON.stringify({ query: query })
    }).then(r => r.json())

    for (const day of result.data.viewer.zones[0].httpRequests1dGroups) {
      pageViews += day.sum.pageViews
      bytes += day.sum.bytes
      users += day.uniq.uniques
    }
  }

  res.status(200).json({
    pageviews: pageViews,
    terabytes: bytes / 1000 / 1000 / 1000 / 1000,
    users: users,
  });
});


router.get('/cfdaily', async (req, res) => {
  const date_from = req.query.date_from;
  const date_to = req.query.date_to;

  let collectionRef = db.collection('cloudflare_analytics');

  collectionRef = date_from ? collectionRef.where('__name__', '>=', date_from) : collectionRef
  collectionRef = date_to ? collectionRef.where('__name__', '<=', date_to) : collectionRef

  const collection = await collectionRef.get();
  let docs = {};
  collection.forEach(doc => {
    const data = doc.data()
    for (const site of Object.values(data)) {
      if (!site.data) continue
      const d = site.data.viewer.zones[0].httpRequests1dGroups[0]
      if (!d) continue
      try {
        delete d.sum.countryMap
        delete d.sum.responseStatusMap
        delete d.sum.ipClassMap
      } catch (err) {
        console.error(err)
      }
    }
    docs[doc.id] = data;
  });

  res.status(200).json(docs);
});

module.exports = router;