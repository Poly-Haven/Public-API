const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const db = firestore()

function countStrings(obj) {
  if (typeof obj === 'string') return 1
  if (typeof obj !== 'object' || obj === null) return 0

  return Object.values(obj).reduce((count, value) => count + countStrings(value), 0)
}

async function fetchTranslationProgress(key) {
  // Get translations from i18nexus API
  // console.log(`Fetching translations for key: ${key}`)
  let url = `https://api.i18nexus.com/project_resources/translations/${key}.json?api_key=${process.env.I18NEXUS_API_KEY}`
  const allTranslations = await fetch(url)
    .then((res) => res.json())
    .catch((err) => {
      console.error(`Error fetching translations for ${key}:`, err)
      return {}
    })
  // console.log(`Fetched confirmed translations for key: ${key}`)
  const confirmedTranslations = await fetch(url + '&confirmed=true')
    .then((res) => res.json())
    .catch((err) => {
      console.error(`Error fetching confirmed translations for ${key}:`, err)
      return {}
    })

  if (allTranslations.error || confirmedTranslations.error) {
    console.error(`Error fetching translations for ${key}:`, allTranslations.error || confirmedTranslations.error)
    return 0
  }

  const allCount = countStrings(allTranslations)
  const confirmedCount = countStrings(confirmedTranslations)

  return allCount > 0 ? Math.round((confirmedCount / allCount) * 100) : 0
}

router.get('/', async (req, res) => {
  const doc = await db.collection('locales').doc('translation_progress').get()

  const data = doc.data()

  // Process all keys in parallel
  const promises = Object.keys(data).map(async (key) => {
    const progress = await fetchTranslationProgress(key)
    return { key, progress }
  })

  const results = await Promise.all(promises)

  // Update data with results
  results.forEach(({ key, progress }) => {
    data[key].progress = progress
  })

  res.status(200).json(data)
})

module.exports = router
