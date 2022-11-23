const crypto = require('crypto')
const escape = require('escape-html')
const express = require('express')
const router = express.Router()

const firestore = require('../firestore')

const db = firestore()

require('dotenv').config()

router.use(express.json())

router.post('/', async (req, res) => {
  if (!req.body.uuid || !req.body.key) {
    res.status(400).json({
      error: '400',
      message: 'Bad request.',
    })
    return
  }

  const uuid = req.body.uuid
  const hash = crypto.createHmac('sha256', process.env.PATRON_INFO_KEY).update(uuid).digest('hex')
  if (req.body.key !== hash) {
    res.status(403).json({
      error: '403 Forbidden',
      message: 'Incorrect key',
    })
    return
  }

  const doc = await db.collection('patrons').doc(uuid).get()
  if (!doc.exists) {
    res.status(404).json({
      error: '404 Not Found',
      message: `No patron with id ${escape(uuid)}`,
    })
  } else {
    res.status(200).json(doc.data())
  }
})

router.patch('/', async (req, res) => {
  if (!req.body.uuid || !req.body.key) {
    res.status(400).json({
      error: '400',
      message: 'Bad request.',
    })
    return
  }

  const uuid = req.body.uuid
  const hash = crypto.createHmac('sha256', process.env.PATRON_INFO_KEY).update(uuid).digest('hex')
  if (req.body.key !== hash) {
    res.status(403).json({
      error: '403 Forbidden',
      message: 'Incorrect key',
    })
    return
  }

  if (!uuid) {
    res.status(400).json({
      error: '400 Bad Request',
      message: 'uuid is undefined',
    })
    return
  }

  let data = JSON.parse(JSON.stringify(req.body))
  delete data.uuid
  delete data.key

  const doc = await db.collection('patrons').doc(uuid)

  doc.set(data, { merge: true })

  res.status(200).json(data)
})

module.exports = router
