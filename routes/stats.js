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
const softwareMatcher = require('../utils/softwareMatcher')

const db = firestore()
// For whole-collection reads of `assets`, which several routes here sweep on every request.
const cachedDb = cachedFirestore()

const TYPE_NAMES = ['hdris', 'textures', 'models']

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
        // Empty is not a value - it means the asset was never assessed for this attribute, the same
        // as an absent enum. "No wear or dirt" is the `clean` tag, so it arrives as a real value.
        if (!list.length) continue
        for (const v of new Set(list.map((x) => String(x)))) bump(agg.values, v, dpd)
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

/**
 * What our audience actually makes things with, from the `software` field on gallery submissions.
 *
 * Counted per artwork rather than per mention, so every number is a share of artworks and the chart
 * can say "X% of people who told us their 3D app used Blender". An artwork naming Blender twice
 * counts once; one naming Blender and Cycles counts towards both, in different categories.
 *
 * Shares are taken against a per-category denominator - `assessed`, the artworks that named at
 * least one product in that category - not against all artworks. Someone who only wrote "Photoshop"
 * has told us nothing about which 3D app they use, and including them would quietly deflate every
 * share in the `dcc` category.
 *
 * The timeline is by calendar year, which is about the finest bucket ~200 artworks a year supports.
 * Each bucket carries its own `assessed` so a thin year can be recognised as thin rather than read
 * as a real swing.
 *
 * Answers the catalog does not recognise are returned in `unrecognised` rather than dropped - it is
 * the worklist for extending the catalog, and it is the only way to notice a product becoming
 * popular before anyone thinks to add it.
 */
const SOFTWARE_TTL = 30 * 60 * 1000
let softwareCache = null
let softwarePending = null

const computeSoftware = async () => {
  const collection = await db.collection('gallery').get()

  // Pass one: strict matching, keeping the unmatched segments for a second look.
  const artworks = []
  let total = 0
  let withSoftware = 0
  collection.forEach((doc) => {
    const data = doc.data()
    if (data.approval_pending) return
    total++
    if (!data.software || !data.software.length) return
    withSoftware++
    const { found, leftovers } = softwareMatcher.parse(data.software)
    artworks.push({
      period: data.date_added ? String(new Date(data.date_added).getUTCFullYear()) : null,
      month: data.date_added ? new Date(data.date_added).toISOString().slice(0, 7) : null,
      found,
      leftovers,
    })
  })

  // Provisional counts, so a truncated segment can be settled by what the corpus actually favours.
  const strictCounts = {}
  for (const a of artworks) {
    for (const key of a.found) strictCounts[key] = (strictCounts[key] || 0) + 1
  }

  // Pass two: fold resolved truncations in, and collect what is still unrecognised.
  const unrecognised = {}
  let unrecognisedMentions = 0
  for (const a of artworks) {
    for (const leftover of a.leftovers) {
      const key = softwareMatcher.resolve(leftover, strictCounts)
      if (key) {
        a.found.add(key)
        continue
      }
      unrecognised[leftover.segment] = (unrecognised[leftover.segment] || 0) + 1
      unrecognisedMentions++
    }
  }

  const { software: defs, categories: categoryDefs } = softwareMatcher.catalog
  const categoryOf = (key) => defs[key].category

  const software = {}
  const categories = {}
  for (const [id, def] of Object.entries(categoryDefs)) {
    categories[id] = { ...def, assessed: 0 }
  }

  const timeline = {}
  const pairs = {}
  let recognised = 0

  for (const a of artworks) {
    if (!a.found.size) continue
    recognised++

    const period = a.period
    if (period && !timeline[period]) {
      timeline[period] = { period, artworks: 0, categories: {} }
    }
    if (period) timeline[period].artworks++

    // Which categories this one artwork spoke to, so each is counted once towards `assessed`.
    const spoken = new Set()
    for (const key of a.found) {
      const category = categoryOf(key)
      spoken.add(category)

      const s = (software[key] = software[key] || {
        label: defs[key].label,
        category,
        count: 0,
        share: 0,
        first: null,
        last: null,
      })
      s.count++
      if (a.month) {
        if (!s.first || a.month < s.first) s.first = a.month
        if (!s.last || a.month > s.last) s.last = a.month
      }

      if (period) {
        const bucket = (timeline[period].categories[category] = timeline[period].categories[category] || {
          assessed: 0,
          counts: {},
        })
        bucket.counts[key] = (bucket.counts[key] || 0) + 1
      }
    }

    for (const category of spoken) {
      categories[category].assessed++
      if (period) timeline[period].categories[category].assessed++
    }

    // Co-occurrence, for "what is this usually paired with". Symmetric, so either side can be the
    // one you pick in the chart.
    const list = [...a.found]
    for (const x of list) {
      for (const y of list) {
        if (x === y) continue
        pairs[x] = pairs[x] || {}
        pairs[x][y] = (pairs[x][y] || 0) + 1
      }
    }
  }

  for (const s of Object.values(software)) {
    const assessed = categories[s.category].assessed
    s.share = assessed ? s.count / assessed : 0
  }

  // A single pairing is a coincidence, and keeping them all roughly triples the size of this
  // response for rows no chart would ever draw.
  for (const [key, partners] of Object.entries(pairs)) {
    const kept = Object.entries(partners).filter(([, n]) => n >= 2)
    if (!kept.length) delete pairs[key]
    else pairs[key] = Object.fromEntries(kept.sort((a, b) => b[1] - a[1]))
  }

  const months = artworks.map((a) => a.month).filter(Boolean)
  const thisYear = String(new Date().getUTCFullYear())

  return {
    meta: {
      artworks: total,
      withSoftware,
      recognised,
      coverage: withSoftware ? recognised / withSoftware : 0,
      unrecognisedMentions,
      first: months.length ? months.reduce((a, b) => (a < b ? a : b)) : null,
      last: months.length ? months.reduce((a, b) => (a > b ? a : b)) : null,
    },
    categories,
    software: Object.fromEntries(Object.entries(software).sort((a, b) => b[1].count - a[1].count)),
    // Ascending, so the chart can plot it as given. The newest bucket is flagged rather than
    // dropped - it is real data, it just is not a whole year yet.
    timeline: Object.keys(timeline)
      .sort()
      .map((p) => ({ ...timeline[p], partial: p === thisYear })),
    pairs,
    // Only repeated ones: the tail is a long list of typos each seen once, and it buries the
    // handful of genuinely missing products worth acting on.
    unrecognised: Object.fromEntries(
      Object.entries(unrecognised)
        .filter(([, n]) => n >= 2)
        .sort((a, b) => b[1] - a[1])
    ),
  }
}

router.get('/software', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600')

  if (softwareCache && Date.now() - softwareCache.time < SOFTWARE_TTL) {
    return res.status(200).json(softwareCache.data)
  }

  // Sweeping the whole `gallery` collection is ~1.9k document reads, and the answer is identical for
  // every caller, so concurrent misses share one computation rather than each starting their own.
  if (!softwarePending) {
    softwarePending = computeSoftware().finally(() => {
      softwarePending = null
    })
  }

  try {
    const data = await softwarePending
    softwareCache = { data, time: Date.now() }
    res.status(200).json(data)
  } catch (e) {
    console.error(e)
    res.status(500).send('Failed to calculate software stats')
  }
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
