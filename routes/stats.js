const express = require('express')
const fetch = require('node-fetch')
const router = express.Router()
const subMonths = require('date-fns/subMonths')
const sortObjBySubObjProp = require('../utils/sortObjBySubObjProp')

require('dotenv').config()

const firestore = require('../firestore')

const db = firestore()

const escapeRegExp = (s) => {
  return s.replace(/[.*+?^${}()[\]\\]/g, '\\$&')
}

const sortObject = (obj) => {
  const sortedKeys = Object.keys(obj).sort(function (a, b) {
    return obj[b] - obj[a]
  })
  let tmpObj = {}
  for (const k of sortedKeys) {
    tmpObj[k] = obj[k]
  }
  return tmpObj
}

const assetsPublishedInDateRange = async (date_from, date_to) => {
  const epoch_end = Date.parse(`${date_to}T23:59:59Z`) / 1000
  const collection = await db.collection('assets').where('date_published', '<=', epoch_end).get()

  let assets = []
  collection.forEach((doc) => {
    assets.push(doc.data())
  })

  const oneDay = 24 * 60 * 60
  let epoch = Date.parse(`${date_from}T23:59:59Z`) / 1000 - oneDay
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
        days[day][type]++
      }
    }
  }

  return days
}

router.get('/downloads', async (req, res) => {
  const slug = req.query.slug
  const type = req.query.type
  const date_from = req.query.date_from
  const date_to = req.query.date_to

  let collectionRef = db.collection('downloads_daily')

  collectionRef = slug ? collectionRef.where('slug', '==', slug) : collectionRef
  collectionRef = type ? collectionRef.where('type', '==', type) : collectionRef
  collectionRef = date_from ? collectionRef.where('day', '>=', date_from) : collectionRef
  collectionRef = date_to ? collectionRef.where('day', '<=', date_to) : collectionRef

  const collection = await collectionRef.get()
  let docs = []
  collection.forEach((doc) => {
    docs.push(doc.data())
  })

  res.status(200).json(docs)
})

router.get('/relativetype', async (req, res) => {
  const date_from = req.query.date_from
  const date_to = req.query.date_to

  let collectionRef = db.collection('downloads_daily')

  const types = {
    T0: 'hdris',
    T1: 'textures',
    T2: 'models',
  }

  collectionRef = collectionRef.where('type', '==', 'TYPE')
  collectionRef = collectionRef.where('slug', 'in', Object.keys(types))
  collectionRef = date_from ? collectionRef.where('day', '>=', date_from) : collectionRef
  collectionRef = date_to ? collectionRef.where('day', '<=', date_to) : collectionRef

  const collection = await collectionRef.get()
  let stats = {}
  collection.forEach((doc) => {
    stats[doc.id] = doc.data()
  })

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
      relative[type] = (value / total) * 100
    }
    if (Object.keys(relative).length) {
      returnData[day] = relative
    }
  }

  res.status(200).json(returnData)
})

router.get('/relativecategory', async (req, res) => {
  let collectionRef = db.collection('assets')

  const collection = await collectionRef.get()
  let assets = {}
  collection.forEach((doc) => {
    assets[doc.id] = doc.data()
  })

  const types = ['hdris', 'textures', 'models']

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
      if (!Object.keys(returnData[t]).includes(cat)) {
        returnData[t][cat] = []
      }
      returnData[t][cat].push(downloadsPerDay)
    }
  }

  // Filter out categories with less than 3 assets
  for (const [t, typeData] of Object.entries(returnData)) {
    for (const [c, data] of Object.entries(typeData)) {
      if (data.length < 3) {
        delete returnData[t][c]
      }
    }
  }

  // Then average the downloads/day for each cat
  const average = (array) => array.reduce((a, b) => a + b) / array.length
  for (const [t, typeData] of Object.entries(returnData)) {
    for (const [c, data] of Object.entries(typeData)) {
      returnData[t][c] = { count: data.length, avg: average(data) }
    }
  }

  res.status(200).json(returnData)
})

router.get('/cfmonth', async (req, res) => {
  // pageViews and bandwidth data for the previous month

  const isoDay = (date) => date.toISOString().substring(0, 10) // YYYY-MM-DD

  const now = Date.now()
  const toDate = isoDay(new Date(now))
  const fromDate = isoDay(subMonths(now, 1))

  const zones = [process.env.CLOUDFLARE_ZONE, process.env.CLOUDFLARE_ZONE_ORG]

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
    const result = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AUTH-EMAIL': process.env.CLOUDFLARE_API_EMAIL,
        authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      },
      body: JSON.stringify({ query: query }),
    }).then((r) => r.json())

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
  })
})

router.get('/cfdaily', async (req, res) => {
  const date_from = req.query.date_from
  const date_to = req.query.date_to

  let collectionRef = db.collection('cloudflare_analytics')

  collectionRef = date_from ? collectionRef.where('__name__', '>=', date_from) : collectionRef
  collectionRef = date_to ? collectionRef.where('__name__', '<=', date_to) : collectionRef

  const collection = await collectionRef.get()
  let docs = {}
  collection.forEach((doc) => {
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
    docs[doc.id] = data
  })

  res.status(200).json(docs)
})

router.get('/software', async (req, res) => {
  let collectionRef = db.collection('gallery')

  const collection = await collectionRef.get()
  let softwareStrings = {}
  collection.forEach((doc) => {
    const data = doc.data()
    if (data.software) {
      if (typeof data.software === 'string' || data.software instanceof String) {
        softwareStrings[data.software] = softwareStrings[data.software] || 0
        softwareStrings[data.software]++
      } else {
        for (const s of data.software) {
          softwareStrings[s] = softwareStrings[s] || 0
          softwareStrings[s]++
        }
      }
    }
  })

  const knownSoftware = {
    dcc: {
      blender: 0,
      maya: 0,
      '3ds max': 0,
      houdini: 0,
      'cinema 4d': 0,
      sketchup: 0,
      'daz studio': 0,
      vred: 0,
      rhino: 0,
      twinmotion: 0,
    },
    game_engine: {
      unity: 0,
      unreal: 0,
      godot: 0,
    },
    render_engine: {
      cycles: 0,
      eevee: 0,
      redshift: 0,
      arnold: 0,
      'v-ray': 0,
      octane: 0,
      corona: 0,
      keyshot: 0,
      'mental ray': 0,
    },
    '2d': {
      photoshop: 0,
      lightroom: 0,
      illustrator: 0,
      gimp: 0,
      inkscape: 0,
      'affinity designer': 0,
      'affinity photo': 0,
      krita: 0,
    },
    other: {
      'substance painter': 0,
      'substance designer': 0,
      mari: 0,
      zbrush: 0,
      mudbox: 0,
      nuke: 0,
      'after effects': 0,
      premiere: 0,
      speedtree: 0,
      meshroom: 0,
      'reality capture': 0,
    },
  }
  const aliases = {
    '3d studio max': '3ds max',
    '3dsmax': '3ds max',
    '3d max': '3ds max',
    '3dx max': '3ds max',
    '3dmax': '3ds max',
    '3ds': '3ds max',
    max: '3ds max',
    max2019: '3ds max',
    c4d: 'cinema 4d',
    cinema4d: 'cinema 4d',
    vray: 'v-ray',
    'v ray': 'v-ray',
    'vray next': 'v-ray',
    'vray3.4': 'v-ray',
    affinity: 'affinity photo',
    daz: 'daz studio',
    daz3d: 'daz studio',
    dazstudio: 'daz studio',
    'daz 3d': 'daz studio',
    'daz 3d studio': 'daz studio',
    'daz3d studio': 'daz studio',
    substance: 'substance painter',
    'substance paint': 'substance painter',
    ps: 'photoshop',
    photosho: 'photoshop',
  }
  const software = {}
  for (const [sRaw, count] of Object.entries(softwareStrings)) {
    const separators = [',', '&', '/', '+', ';', ' and ', ' with ', ' using ', ' in ']
    const split = sRaw.toLowerCase().split(new RegExp(escapeRegExp(separators.join('|')), 'g'))
    for (let s of split) {
      s = s.trim()
      if (s === '') continue
      software[s] = software[s] || 0
      software[s] += count
    }
  }

  const noMatch = {}
  for (let [s, count] of Object.entries(software)) {
    let found = false
    if (Object.keys(aliases).includes(s)) {
      s = aliases[s]
    }
    for (const [category, categorySoftware] of Object.entries(knownSoftware)) {
      for (const [software, softwareCount] of Object.entries(categorySoftware)) {
        if (s.includes(software)) {
          knownSoftware[category][software] += count
          found = true
        }
      }
    }
    if (!found) {
      noMatch[s] = count
    }
  }

  for (const [category, categorySoftware] of Object.entries(knownSoftware)) {
    knownSoftware[category] = sortObject(categorySoftware)
  }

  res.status(200).json({ knownSoftware, noMatch: sortObject(noMatch) })
})

router.get('/searches', async (req, res) => {
  const types = ['hdris', 'textures', 'models']
  let collectionRef = db.collection('searches').orderBy('timestamp', 'desc').limit(50000)

  const collection = await collectionRef.get()

  const searches = collection.docs
    .map((doc) => doc.data())
    .filter((dd) => dd.search_term && dd.search_term.length >= 3 && isNaN(dd.search_term) && types.includes(dd.type))

  const returnData = { hdris: {}, textures: {}, models: {} }

  for (const search of searches) {
    const t = search.type
    const s = search.search_term.trim().toLowerCase()

    if (!returnData[t][s]) {
      returnData[t][s] = { count: 0, total: 0 }
    }
    returnData[t][s].count++
    returnData[t][s].total += search.results
  }

  for (const type in returnData) {
    for (const term in returnData[type]) {
      returnData[type][term].avg = returnData[type][term].total / returnData[type][term].count
      delete returnData[type][term].total // Clean up
    }
  }

  // Top searches logic...
  for (const type in returnData) {
    const sorted = Object.entries(returnData[type])
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, 50)
      .reduce((obj, [key, value]) => ({ ...obj, [key]: value }), {})

    returnData[type] = sorted
  }

  returnData.meta = {
    total: searches.length,
    earliestSearch: searches[searches.length - 1]?.timestamp,
    latestSearch: searches[0]?.timestamp,
  }

  res.status(200).json(returnData)
})

router.get('/post_download', async (req, res) => {
  const returnData = {}
  const msPerDay = 24 * 60 * 60 * 1000
  const aMonthAgo = new Date(Date.now() - 31 * msPerDay).toISOString().split('T')[0]
  const today = new Date().toISOString().split('T')[0]
  const threeYearsAgo = new Date(Date.now() - 1096 * msPerDay).toISOString().split('T')[0]
  const twelveMonthsAgo = new Date(Date.now() - 366 * msPerDay).toISOString().split('T')[0]

  // MonthlyDownloads
  let collectionRef = db.collection('downloads_daily')
  collectionRef = collectionRef.where('slug', '==', 'ALL')
  collectionRef = collectionRef.where('type', '==', 'ALL')
  collectionRef = collectionRef.where('day', '>=', aMonthAgo)
  let collection = await collectionRef.get()
  let numMonthlyDownloads = 0
  collection.forEach((doc) => {
    numMonthlyDownloads += doc.data().downloads
  })
  returnData.numMonthlyDownloads = numMonthlyDownloads

  // First get finances, we'll need them later
  collectionRef = db.collection('finances')
  collection = await collectionRef.get()
  let finances = {}
  collection.forEach((doc) => {
    finances[doc.id] = doc.data()
  })

  // Monthly Web Hosting Fees
  let yearlyWebHostingFees = 0
  let zarPerUsd = 0
  const last12Months = Object.keys(finances).sort().slice(-12)
  for (const month of last12Months) {
    const expenses = finances[month].expense
    yearlyWebHostingFees += expenses['Web Hosting'] || 0
    zarPerUsd = finances[month].rates['USD']
  }
  const averageMonthlyWebHostingFees = yearlyWebHostingFees / 12
  returnData.averageMonthlyWebHostingFees = averageMonthlyWebHostingFees / zarPerUsd

  // 3-year expenses
  const last3Years = Object.keys(finances).sort().slice(-36)
  let totalExpenses = 0
  for (const month of last3Years) {
    const expenses = finances[month].expense
    let monthlyExpenses = 0
    for (const [category, amount] of Object.entries(expenses)) {
      monthlyExpenses += amount
      totalExpenses += amount
    }
  }
  returnData.averageMonthlyExpenses = totalExpenses / zarPerUsd / 36

  // Assets published in 3 years
  collection = await db
    .collection('assets')
    .where('date_published', '>', Date.parse(`${threeYearsAgo}T23:59:59Z`) / 1000)
    .get()
  returnData.averageAssetsPerMonth = collection.size / 36

  res.status(200).json(returnData)
})

router.get('/patron_count', async (req, res) => {
  const collection = await db.collection('patron_counts').get()
  const summary = {}

  collection.forEach((doc) => {
    const month = doc.id
    const monthData = doc.data()
    const monthSummary = {}

    for (const day in monthData) {
      const dayData = monthData[day]
      const values = Object.values(dayData)
      monthSummary[day] = values.length ? Math.max(...values) : 0
    }

    summary[month] = monthSummary
  })

  res.status(200).json(summary)
})

module.exports = router
