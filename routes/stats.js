const express = require('express')
const fetch = require('node-fetch')
const router = express.Router()
const subMonths = require('date-fns/subMonths')
const sortObjBySubObjProp = require('../utils/sortObjBySubObjProp')

require('dotenv').config()

const firestore = require('../firestore')
const cachedFirestore = require('../utils/cachedFirestore')
const attributeSchema = require('../attributes.json')
const { resolveCategory } = require('../utils/assetFilters')

const db = firestore()
// For whole-collection reads of `assets`, which several routes here sweep on every request.
const cachedDb = cachedFirestore()

const TYPE_NAMES = ['hdris', 'textures', 'models']

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

// downloads_daily is ~2.9M documents and grows by ~2.3k/day, ~91% of it type=ASSET.
// Left unguarded, `/stats/downloads` with no parameters scans the whole collection
// on a public unauthenticated endpoint, and Cloudflare's cache key includes the
// query string, so a junk parameter bypasses the edge cache entirely. Every known
// caller already passes `type`.
const DOWNLOAD_TYPES = ['ALL', 'TYPE', 'TYPE_FORMAT', 'TYPE_RES', 'ASSET']

// ALL and TYPE are ~1 and ~3 documents/day, so all of history is only a few
// thousand documents — cheap to serve, and useful for long-range charts.
const UNCAPPED_DOWNLOAD_TYPES = ['ALL', 'TYPE']
const MAX_RANGE_DAYS = 400

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s)
const dayOffset = (day, days) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().split('T')[0]

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
  let date_from = req.query.date_from
  let date_to = req.query.date_to

  const badRequest = (message) => res.status(400).json({ error: '400 Bad Request', message })

  if (!DOWNLOAD_TYPES.includes(type)) {
    return badRequest(`type is required, and must be one of: ${DOWNLOAD_TYPES.join(', ')}`)
  }
  // type=ASSET is 2.6M of the 2.9M documents, so it is never served unfiltered.
  if (type === 'ASSET' && !slug) {
    return badRequest('slug is required when type=ASSET')
  }
  for (const [name, value] of [
    ['date_from', date_from],
    ['date_to', date_to],
  ]) {
    if (value !== undefined && !isDay(value)) {
      return badRequest(`${name} must be a YYYY-MM-DD date`)
    }
  }
  if (date_from && date_to && date_from > date_to) {
    return badRequest('date_from must not be after date_to')
  }
  // A slug pins the query to one series (~1 document/day), so only an unpinned
  // query over one of the wider types needs a ceiling on its date range.
  if (!slug && !UNCAPPED_DOWNLOAD_TYPES.includes(type)) {
    // Fill in whichever bound is missing first, so that supplying only one of
    // them can't sidestep the span check below.
    date_to = date_to || new Date().toISOString().split('T')[0]
    date_from = date_from || dayOffset(date_to, -MAX_RANGE_DAYS)
    if (date_from < dayOffset(date_to, -MAX_RANGE_DAYS)) {
      return badRequest(
        `date range must be at most ${MAX_RANGE_DAYS} days for type=${type} without a slug. ` +
          `Request a narrower range, or pass a slug.`
      )
    }
  }

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
  let collectionRef = cachedDb.collection('assets')

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

/**
 * Popularity of the single-path taxonomy: aggregates per category node and per attribute value.
 *
 * The successor to /relativecategory, which is keyed by the legacy multi-value `categories` array.
 * Both are served in parallel until nothing reads the old one any more.
 *
 * Category counts are INCLUSIVE, matching how the library browses: an asset in
 * "Nature/Trees/Oaks" counts towards "Nature", "Nature/Trees" and "Nature/Trees/Oaks". `direct` is
 * how many sit exactly on that node, so the pair shows where in a branch the assets actually live.
 * Only nodes with at least one asset appear - an empty category has no popularity to report.
 *
 * `avg` is the mean of each asset's lifetime downloads per day, the same measure the old chart
 * used, so numbers stay comparable across the transition.
 *
 * Attribute buckets mirror what the library can actually filter by, so a chart point maps onto a
 * real query. Booleans report both sides (absent means false); enums report only the values that
 * were assessed, and each attribute's `assessed` against the type's entry in `totals` says how much
 * of the type the chart covers. A multi-value attribute counts an asset once per value it carries,
 * so its buckets deliberately sum to more than `assessed`.
 *
 * Reads `assets` through cachedFirestore, the same 10-minute whole-collection cache /assets and
 * /relativecategory already share, so this route adds no Firestore reads of its own.
 */
router.get('/taxonomy', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600')

  const collection = await cachedDb.collection('assets').get()
  const now = Date.now() / 1000

  const byType = () => ({ hdris: {}, textures: {}, models: {} })
  const categories = byType()
  const attributes = byType()
  const totals = { hdris: 0, textures: 0, models: 0 }

  // Every bucket accumulates a downloads/day sum, turned into a mean at the end.
  const bump = (bucket, key, dpd) => {
    const b = (bucket[key] = bucket[key] || { count: 0, sum: 0 })
    b.count++
    b.sum += dpd
    return b
  }

  for (const [type, spec] of Object.entries(attributeSchema.types)) {
    if (!attributes[type]) continue
    for (const [key, def] of Object.entries(spec)) {
      attributes[type][key] = { type: def.type, enum: def.enum || null, assessed: 0, values: {} }
    }
  }

  collection.forEach((doc) => {
    const asset = doc.data()
    const type = TYPE_NAMES[asset.type]
    if (!type || asset.staging) return
    if (asset.date_published > now) return // not published yet
    const days = (now - asset.date_published) / 86400
    // A brand new asset's downloads/day is dominated by its launch spike, so it would land far off
    // the top of the chart and drag its category's mean with it.
    if (days < 1) return
    const dpd = (asset.download_count || 0) / days

    totals[type]++

    // Categories, rolled up the path. Validated against the taxonomy so a stale or hand-edited
    // path cannot invent a chart point for a category that does not exist.
    const path = typeof asset.category === 'string' ? asset.category : ''
    if (path && resolveCategory(type, path) === path) {
      const parts = path.split('/')
      for (let i = 1; i <= parts.length; i++) {
        const node = bump(categories[type], parts.slice(0, i).join('/'), dpd)
        if (i === parts.length) node.direct = (node.direct || 0) + 1
      }
    }

    // Attributes
    const attrs = asset.attributes || {}
    for (const [key, agg] of Object.entries(attributes[type])) {
      const value = attrs[key]
      if (agg.type === 'boolean') {
        // Only ever stored when true, so absent means false - and false is a real answer here,
        // which is the whole point of comparing the two sides.
        bump(agg.values, value === true || value === 'true' ? 'true' : 'false', dpd)
        agg.assessed++
        continue
      }
      if (agg.type === 'string[]') {
        const list = Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]
        // The empty side is a value the library can filter for (?condition=none), so it gets a
        // bucket rather than being dropped as unassessed.
        if (!list.length) bump(agg.values, 'none', dpd)
        else for (const v of new Set(list.map((x) => String(x)))) bump(agg.values, v, dpd)
        agg.assessed++
        continue
      }
      // enum and enum|null: absent or null means never assessed, and there is nothing to plot.
      if (value === undefined || value === null || value === '') continue
      bump(agg.values, String(value), dpd)
      agg.assessed++
    }
  })

  const finalise = (bucket) => {
    for (const b of Object.values(bucket)) {
      b.avg = b.sum / b.count
      delete b.sum
    }
  }
  for (const type of TYPE_NAMES) {
    finalise(categories[type])
    for (const agg of Object.values(attributes[type])) finalise(agg.values)
  }

  res.status(200).json({ totals, categories, attributes })
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

// /post_download takes no parameters and hands the same few numbers to every caller, yet computing
// it costs well over a thousand document reads. polyhaven.com asks for it once per asset page, so a
// full site build used to trigger thousands of identical recomputations. Cache the result, and
// collapse concurrent misses into a single computation so a build cannot stampede a cold cache.
const POST_DOWNLOAD_TTL = 10 * 60 * 1000
let postDownloadCache = null
let postDownloadPending = null

const computePostDownload = async () => {
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

  // Assets published in 3 years.
  // Counted from the shared assets cache rather than queried, since this alone was over a thousand
  // document reads per call. Note cachedFirestore only understands == and array-contains, so the
  // date comparison has to happen here rather than in a where().
  const publishedAfter = Date.parse(`${threeYearsAgo}T23:59:59Z`) / 1000
  collection = await cachedDb.collection('assets').get()
  let recentAssets = 0
  collection.forEach((doc) => {
    if (doc.data().date_published > publishedAfter) {
      recentAssets++
    }
  })
  returnData.averageAssetsPerMonth = recentAssets / 36

  return returnData
}

router.get('/post_download', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600')

  if (postDownloadCache && Date.now() - postDownloadCache.time < POST_DOWNLOAD_TTL) {
    res.status(200).json(postDownloadCache.data)
    return
  }

  if (!postDownloadPending) {
    postDownloadPending = computePostDownload().finally(() => {
      postDownloadPending = null
    })
  }

  try {
    const data = await postDownloadPending
    postDownloadCache = { data, time: Date.now() }
    res.status(200).json(data)
  } catch (e) {
    console.error(e)
    res.status(500).send('Failed to calculate post-download stats')
  }
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
