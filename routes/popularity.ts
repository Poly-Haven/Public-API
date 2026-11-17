import { addDays } from 'date-fns'
import { addMonths } from 'date-fns'
import type { FastifyInstance } from 'fastify'
import type { Query as FsQuery } from 'firebase-admin/firestore'

import sortObjBySubObjProp from '../utils/sortObjBySubObjProp.ts'
import firestore from '../firestore.ts'
import type { Asset, DownloadDaily } from '../types/firestore.ts'
import type { Query } from '../types/http.ts'
import { sendText } from '../utils/http.ts'

const db = firestore()

interface DownloadStats {
  days: number[]
  warning: boolean
}

interface PopularityInfo {
  popularity: number
  sum: number
  warning: boolean
  author?: string
  backplates?: boolean
  bonus?: number
}

interface PopularityEntry {
  slug: string
  name: string
  date_published: number
  author: string | undefined
  unique_downloads: number
  popularity: number
  bonus: number | undefined
  backplates?: boolean | undefined
  warning: boolean
}

export default async function (fastify: FastifyInstance) {
  fastify.get('/', (req, reply) => {
    return sendText(reply, 400, `Please format your request as /popularity/[YYYY-MM]`)
  })

  fastify.get<{ Params: { month: string }; Querystring: Query }>('/:month', async (req, reply) => {
    const month = req.params.month
    const share_amount = parseFloat(String(req.query.share_amount))

    if (!share_amount && share_amount !== 0) {
      return sendText(reply, 400, 'Invalid share_amount')
    }

    // Convert month input to epoch range
    const epochStart = Math.round(new Date(month).valueOf() / 1000)
    const epochEnd = Math.round(addMonths(new Date(month), 1).valueOf() / 1000)

    // Get list of HDRIs published this month
    const colHDRIs = await db
      .collection('assets')
      .where('date_published', '>=', epochStart)
      .where('date_published', '<', epochEnd)
      .where('type', '==', 0)
      .get()
    let hdris: Record<string, Asset> = {}
    colHDRIs.forEach((doc) => {
      const info = doc.data() as Asset
      if (!info.prepaid && !info.donated) {
        // Ignore HDRIs not eligible for bonus earnings.
        hdris[doc.id] = info
      }
    })

    // Get download stats for first 28 days after each HDRI was published
    let stats: Record<string, DownloadStats> = {}
    for (const [slug, info] of Object.entries(hdris)) {
      const date_from = new Date(info.date_published * 1000).toISOString().split('T')[0]
      const date_to = addDays(new Date(info.date_published * 1000), 27)
        .toISOString()
        .split('T')[0]
      const warning = date_to >= new Date().toISOString().split('T')[0] // If 28 day period is not over, popularity value will change.

      let colRef: FsQuery = db.collection('downloads_daily')
      colRef = colRef.where('slug', '==', slug)
      colRef = colRef.where('type', '==', 'ASSET')
      colRef = colRef.where('day', '>=', date_from)
      colRef = colRef.where('day', '<=', date_to)
      const colStats = await colRef.get()
      let days: number[] = []
      colStats.forEach((doc) => {
        // Use "unique" downloads as a measure of "users" instead of actual downloads,
        // which would include duplicate downloads and downloads of multiple files separately.
        days.push((doc.data() as DownloadDaily).unique)
      })

      days = days.sort((a, b) => a - b) // Sort downloads per day in ascending order.
      stats[slug] = { days, warning }
    }

    // Statistical maniplulation to lower the influence of large spikes and troughs in downloads.
    let popularities: Record<string, PopularityInfo> = {}
    for (const [slug, info] of Object.entries(stats)) {
      const days = info.days
      const sum = days.reduce((a, b) => a + b, 0)
      const q1 = days[Math.round(days.length * 0.25)]
      const q3 = days[Math.round(days.length * 0.75)]
      const days_clamped = days.map((d) => Math.min(q3, Math.max(d, q1))) // Downloads per day clamped inside IQR.

      // Average clamped downloads per day - this is the "absolute" popularity value.
      const popularity = days_clamped.reduce((a, b) => a + b, 0) / days_clamped.length
      popularities[slug] = { popularity, sum, warning: info.warning }
    }

    // If an HDRI includes backplates, add 40%, but only for each author's most popular one.
    popularities = sortObjBySubObjProp(popularities, 'popularity')
    let ignoreAuthors: string[] = []
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
    const totalPopularity = Object.values(popularities).reduce((a, b) => ({
      ...a,
      popularity: a.popularity + b.popularity,
    })).popularity
    for (const [slug, info] of Object.entries(popularities)) {
      info.popularity = info.popularity / totalPopularity
      if (share_amount !== 0) {
        info.bonus = info.popularity * share_amount
      }
    }

    // Gather the info we need to display on the page.
    let returnData: { hdris: PopularityEntry[]; author_totals: Record<string, number> } = {
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
      // `author` is set for every entry by here (the textures route deleted those without one). `bonus` is
      // undefined when share_amount is 0, which makes the total NaN (null in JSON) - kept as it always was.
      const author = popInfo.author as string
      returnData.author_totals[author] = returnData.author_totals[author] || 0
      returnData.author_totals[author] += popInfo.bonus as number
    }

    return reply.code(200).send(returnData)
  })

  fastify.get<{ Params: { month: string } }>('/tex/:month', async (req, reply) => {
    const month = req.params.month

    // Convert month input to epoch range
    const epochStart = Math.round(new Date(month).valueOf() / 1000)
    const epochEnd = Math.round(addMonths(new Date(month), 1).valueOf() / 1000)

    // Get list of textures published this month
    const colTex = await db
      .collection('assets')
      .where('date_published', '>=', epochStart)
      .where('date_published', '<', epochEnd)
      .where('type', '==', 1)
      .get()
    let textures: Record<string, Asset> = {}
    colTex.forEach((doc) => {
      const info = doc.data() as Asset
      if (!info.prepaid && !info.donated) {
        // Ignore textures not eligible for bonus earnings.
        textures[doc.id] = info
      }
    })

    // Get download stats for first 28 days after each texture was published
    let stats: Record<string, DownloadStats> = {}
    for (const [slug, info] of Object.entries(textures)) {
      const date_from = new Date(info.date_published * 1000).toISOString().split('T')[0]
      const date_to = addDays(new Date(info.date_published * 1000), 27)
        .toISOString()
        .split('T')[0]
      const warning = date_to >= new Date().toISOString().split('T')[0] // If 28 day period is not over, popularity value will change.

      let colRef: FsQuery = db.collection('downloads_daily')
      colRef = colRef.where('slug', '==', slug)
      colRef = colRef.where('type', '==', 'ASSET')
      colRef = colRef.where('day', '>=', date_from)
      colRef = colRef.where('day', '<=', date_to)
      const colStats = await colRef.get()
      let days: number[] = []
      colStats.forEach((doc) => {
        // Use "unique" downloads as a measure of "users" instead of actual downloads,
        // which would include duplicate downloads and downloads of multiple files separately.
        days.push((doc.data() as DownloadDaily).unique)
      })

      days = days.sort((a, b) => a - b) // Sort downloads per day in ascending order.
      stats[slug] = { days, warning }
    }

    // Statistical maniplulation to lower the influence of large spikes and troughs in downloads.
    let popularities: Record<string, PopularityInfo> = {}
    for (const [slug, info] of Object.entries(stats)) {
      const days = info.days
      const sum = days.reduce((a, b) => a + b, 0)
      const q1 = days[Math.round(days.length * 0.25)]
      const q3 = days[Math.round(days.length * 0.75)]
      const days_clamped = days.map((d) => Math.min(q3, Math.max(d, q1))) // Downloads per day clamped inside IQR.

      // Average clamped downloads per day - this is the "absolute" popularity value.
      const popularity = days_clamped.reduce((a, b) => a + b, 0) / days_clamped.length
      popularities[slug] = { popularity, sum, warning: info.warning }
    }
    popularities = sortObjBySubObjProp(popularities, 'popularity')

    // Get author.
    const ignore_authors = ['Dario Barresi', 'Rob Tuytel', 'Rico Cilliers']
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
        delete popularities[slug]
      }
    }

    const bonus_per_tex = month >= '2022-11' ? 100 : 50
    const share_amount = bonus_per_tex * Object.keys(popularities).length

    // Calculate relative popularity & bonus amounts
    const totalPopularity = Object.values(popularities).reduce((a, b) => ({
      ...a,
      popularity: a.popularity + b.popularity,
    })).popularity
    for (const [slug, info] of Object.entries(popularities)) {
      info.popularity = info.popularity / totalPopularity
      if (share_amount !== 0) {
        info.bonus = info.popularity * share_amount
      }
    }

    // Gather the info we need to display on the page.
    let returnData: { textures: PopularityEntry[]; author_totals: Record<string, number> } = {
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
      // `author` is set for every entry by here (the textures route deleted those without one). `bonus` is
      // undefined when share_amount is 0, which makes the total NaN (null in JSON) - kept as it always was.
      const author = popInfo.author as string
      returnData.author_totals[author] = returnData.author_totals[author] || 0
      returnData.author_totals[author] += popInfo.bonus as number
    }

    return reply.code(200).send(returnData)
  })
}
