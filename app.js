const express = require('express')
const cors = require('cors')
const fs = require('fs')
const YAML = require('yamljs')
require('dotenv').config()

const app = express()
app.use(cors())

let debugRequests = false
const isDev = process.env.NODE_ENV === 'development'
// Middleware that logs the request url to the console
app.use((req, res, next) => {
  if (debugRequests || isDev) {
    // Random emoji to make it easier to find in the logs, using the current second as the seed
    const emojiOptions = ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸']
    const emoji = emojiOptions[new Date().getSeconds() % emojiOptions.length]
    console.log(emoji, req.url)
  }
  next()
})

// Middleware to add the ToS to every response
app.use((req, res, next) => {
  res.setHeader('Terms-Of-Service', 'https://github.com/Poly-Haven/Public-API/blob/master/ToS.md')
  next()
})

const swaggerDocument = YAML.load('./swagger.yml')
app.get('/api-docs/swagger.json', (req, res) => res.json(swaggerDocument))

// Debug toggle endpoint
app.post('/debug/:state', (req, res) => {
  const authHeader = req.headers.authorization
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null

  if (token !== process.env.DL_KEY) {
    res.status(403).json({
      error: '403 Forbidden',
      message: 'Incorrect key',
    })
    return
  }

  const { state } = req.params
  if (state === 'on') {
    debugRequests = true
  } else if (state === 'off') {
    debugRequests = false
  } else {
    res.status(400).json({
      error: '400 Bad Request',
      message: 'Invalid state. Use "on" or "off"',
    })
    return
  }

  res.json({
    debug: debugRequests,
    message: `Request logging ${debugRequests ? 'enabled' : 'disabled'}`,
    node: process.env.NODE_ID || 'UNKNOWN',
  })
})

const routeDir = './routes/'
fs.readdir(routeDir, (err, files) => {
  files.forEach((file) => {
    fn = file.split('.')[0]
    if (fn === 'tmp' && process.env.NODE_ENV !== 'development') return
    const r = require(routeDir + fn)
    try {
      app.use('/' + fn, r)
    } catch (err) {
      console.log('Failed to register endpoint', fn)
      console.log(err)
    }
  })
})

app.get('/', (req, res) => {
  res.status(200).send(`Welcome to the Poly Haven API!
  Documentation for available endpoints is here:
  https://redocly.github.io/redoc/?url=https://api.polyhaven.com/api-docs/swagger.json&nocors`)
})

app.listen(3000)
