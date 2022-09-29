const addDays = require('date-fns/addDays')
const addMonths = require('date-fns/addMonths')
const express = require('express');
const router = express.Router();

const sortObjBySubObjProp = require('../utils/sortObjBySubObjProp')
const firestore = require('../firestore');

const db = firestore();

router.get('/', (req, res) => {
  res.status(400).send(`Please format your request as /popularity/[YYYY-MM]`);
});

router.get('/:month', async (req, res) => {
  const month = req.params.month;
  const share_amount = parseFloat(req.query.share_amount);

  if (!share_amount && share_amount !== 0) {
    res.status(400).send("Invalid share_amount");
    return;
  }

  // Convert month input to epoch range
  const epochStart = Math.round(new Date(month).valueOf() / 1000)
  const epochEnd = Math.round(addMonths(new Date(month), 1).valueOf() / 1000)

  // Get list of HDRIs published this month
  const colHDRIs = await db.collection('assets').where('date_published', '>=', epochStart).where('date_published', '<', epochEnd).where('type', '==', 0).get();
  let hdris = {};
  colHDRIs.forEach(doc => {
    const info = doc.data()
    if (!info.prepaid && !info.donated) {  // Ignore HDRIs not eligible for bonus earnings.
      hdris[doc.id] = info;
    }
  });

  // Get download stats for first 28 days after each HDRI was published
  let stats = {}
  for (const [slug, info] of Object.entries(hdris)) {
    const date_from = new Date(info.date_published * 1000).toISOString().split('T')[0]
    const date_to = addDays(new Date(info.date_published * 1000), 27).toISOString().split('T')[0]
    const warning = date_to >= new Date().toISOString().split('T')[0] // If 28 day period is not over, popularity value will change.

    let colRef = db.collection('downloads_daily');
    colRef = colRef.where('slug', '==', slug)
    colRef = colRef.where('type', '==', 'ASSET')
    colRef = colRef.where('day', '>=', date_from)
    colRef = colRef.where('day', '<=', date_to)
    const colStats = await colRef.get();
    let days = [];
    colStats.forEach(doc => {
      // Use "unique" downloads as a measure of "users" instead of actual downloads,
      // which would include duplicate downloads and downloads of multiple files separately.
      days.push(doc.data().unique);
    });

    days = days.sort((a, b) => a - b); // Sort downloads per day in ascending order.
    stats[slug] = { days, warning }
  }

  // Statistical maniplulation to lower the influence of large spikes and troughs in downloads.
  let popularities = {}
  for (const [slug, info] of Object.entries(stats)) {
    const days = info.days
    const sum = days.reduce((a, b) => a + b, 0)
    const q1 = days[Math.round(days.length * 0.25)]
    const q3 = days[Math.round(days.length * 0.75)]
    const days_clamped = days.map(d => Math.min(q3, Math.max(d, q1))) // Downloads per day clamped inside IQR.

    // Average clamped downloads per day - this is the "absolute" popularity value.
    const popularity = days_clamped.reduce((a, b) => a + b, 0) / days_clamped.length;
    popularities[slug] = { popularity, sum, warning: info.warning }
  }

  // If an HDRI includes backplates, add 40%, but only for each author's most popular one.
  popularities = sortObjBySubObjProp(popularities, 'popularity')
  let ignoreAuthors = []
  for (const [slug, popInfo] of Object.entries(popularities)) {
    const info = hdris[slug]
    popInfo.author = Object.keys(info.authors)[0] // Multi-author HDRIs are not supported, just use the first one.
    if (info.backplates && !ignoreAuthors.includes(popInfo.author)) {
      ignoreAuthors.push(popInfo.author)
      popInfo.backplates = true
      popInfo.popularity *= 1.4
    }
  }
  popularities = sortObjBySubObjProp(popularities, 'popularity') // Sort again, since we adjusted popularities order might have changed.

  // Calculate relative popularity & bonus amounts
  const totalPopularity = Object.values(popularities).reduce((a, b) => ({ popularity: a.popularity + b.popularity })).popularity
  for (const [slug, info] of Object.entries(popularities)) {
    info.popularity = info.popularity / totalPopularity
    if (share_amount !== 0) {
      info.bonus = info.popularity * share_amount
    }
  }

  // Gather the info we need to display on the page.
  let returnData = {
    hdris: [],
    author_totals: {},
  }
  for (const [slug, popInfo] of Object.entries(popularities)) {
    const info = hdris[slug]
    returnData.hdris.push({
      slug: slug,
      name: info.name,
      date_published: info.date_published,
      author: popInfo.author,
      unique_downloads: popInfo.sum,
      popularity: popInfo.popularity,
      bonus: popInfo.bonus,
      backplates: popInfo.backplates,
      warning: popInfo.warning,
    })
    returnData.author_totals[popInfo.author] = returnData.author_totals[popInfo.author] || 0
    returnData.author_totals[popInfo.author] += popInfo.bonus
  }

  res.status(200).json(returnData);
});

router.get('/tex/:month', async (req, res) => {
  const month = req.params.month;

  // Convert month input to epoch range
  const epochStart = Math.round(new Date(month).valueOf() / 1000)
  const epochEnd = Math.round(addMonths(new Date(month), 1).valueOf() / 1000)

  // Get list of textures published this month
  const colTex = await db.collection('assets').where('date_published', '>=', epochStart).where('date_published', '<', epochEnd).where('type', '==', 1).get();
  let textures = {};
  colTex.forEach(doc => {
    const info = doc.data()
    if (!info.prepaid && !info.donated) {  // Ignore textures not eligible for bonus earnings.
      textures[doc.id] = info;
    }
  });

  // Get download stats for first 28 days after each texture was published
  let stats = {}
  for (const [slug, info] of Object.entries(textures)) {
    const date_from = new Date(info.date_published * 1000).toISOString().split('T')[0]
    const date_to = addDays(new Date(info.date_published * 1000), 27).toISOString().split('T')[0]
    const warning = date_to >= new Date().toISOString().split('T')[0] // If 28 day period is not over, popularity value will change.

    let colRef = db.collection('downloads_daily');
    colRef = colRef.where('slug', '==', slug)
    colRef = colRef.where('type', '==', 'ASSET')
    colRef = colRef.where('day', '>=', date_from)
    colRef = colRef.where('day', '<=', date_to)
    const colStats = await colRef.get();
    let days = [];
    colStats.forEach(doc => {
      // Use "unique" downloads as a measure of "users" instead of actual downloads,
      // which would include duplicate downloads and downloads of multiple files separately.
      days.push(doc.data().unique);
    });

    days = days.sort((a, b) => a - b); // Sort downloads per day in ascending order.
    stats[slug] = { days, warning }
  }

  // Statistical maniplulation to lower the influence of large spikes and troughs in downloads.
  let popularities = {}
  for (const [slug, info] of Object.entries(stats)) {
    const days = info.days
    const sum = days.reduce((a, b) => a + b, 0)
    const q1 = days[Math.round(days.length * 0.25)]
    const q3 = days[Math.round(days.length * 0.75)]
    const days_clamped = days.map(d => Math.min(q3, Math.max(d, q1))) // Downloads per day clamped inside IQR.

    // Average clamped downloads per day - this is the "absolute" popularity value.
    const popularity = days_clamped.reduce((a, b) => a + b, 0) / days_clamped.length;
    popularities[slug] = { popularity, sum, warning: info.warning }
  }
  popularities = sortObjBySubObjProp(popularities, 'popularity')

  // Get author.
  ignore_authors = [
    "Dario Barresi",
    "Rob Tuytel",
    "Rico Cilliers",
  ]
  for (const [slug, popInfo] of Object.entries(popularities)) {
    const info = textures[slug]
    for (const a of Object.keys(info.authors)) {
      if (!ignore_authors.includes(a)) {
        // Multi-author textures are not supported, just use the first (not ignored) one.
        popInfo.author = a
        break
      }
    }
    if (!popInfo.author) {
      delete popularities[slug];
    }
  }

  const bonus_per_tex = month >= "2022-11" ? 100 : 50;
  const share_amount = bonus_per_tex * Object.keys(popularities).length;

  // Calculate relative popularity & bonus amounts
  const totalPopularity = Object.values(popularities).reduce((a, b) => ({ popularity: a.popularity + b.popularity })).popularity
  for (const [slug, info] of Object.entries(popularities)) {
    info.popularity = info.popularity / totalPopularity
    if (share_amount !== 0) {
      info.bonus = info.popularity * share_amount
    }
  }

  // Gather the info we need to display on the page.
  let returnData = {
    textures: [],
    author_totals: {},
  }
  for (const [slug, popInfo] of Object.entries(popularities)) {
    const info = textures[slug]
    returnData.textures.push({
      slug: slug,
      name: info.name,
      date_published: info.date_published,
      author: popInfo.author,
      unique_downloads: popInfo.sum,
      popularity: popInfo.popularity,
      bonus: popInfo.bonus,
      warning: popInfo.warning,
    })
    returnData.author_totals[popInfo.author] = returnData.author_totals[popInfo.author] || 0
    returnData.author_totals[popInfo.author] += popInfo.bonus
  }

  res.status(200).json(returnData);
});

module.exports = router;