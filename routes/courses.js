const escape = require('escape-html')
const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const db = firestore()

// GET /courses — all courses, keyed by id
router.get('/', async (req, res) => {
  const col = await db.collection('courses').get()
  let courses = {}
  col.forEach((doc) => {
    courses[doc.id] = doc.data()
    courses[doc.id].id = doc.id
  })
  res.status(200).json(courses)
})

// GET /courses/:id — a single course
router.get('/:id', async (req, res) => {
  const id = req.params.id

  if (!id) {
    res.status(400).send(`No course with that ID`)
    return
  }
  const MAX_ID_LENGTH = 50
  if (id.length > MAX_ID_LENGTH) {
    res.status(400).send(`No course with that ID`)
    return
  }
  const validPattern = /^[a-zA-Z0-9_-]+$/
  if (!validPattern.test(id)) {
    res.status(400).send(`No course with that ID`)
    return
  }

  const doc = await db.collection('courses').doc(id).get()
  if (!doc.exists) {
    res.status(404).send(`No course with id ${escape(id)}`)
  } else {
    const data = doc.data()
    data.id = doc.id
    res.status(200).json(data)
  }
})

module.exports = router
