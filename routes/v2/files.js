const escape = require('escape-html')

const cachedFirestore = require('../../utils/cachedFirestore')
const validateKey = require('../../utils/validateKey')
const { sendText } = require('../../utils/http')
const db = cachedFirestore()

module.exports = async function (fastify) {
  fastify.get('/', (req, reply) => {
    return sendText(reply, 400, `Please format your request as /files/[asset_id]`)
  })

  fastify.get('/:id', async (req, reply) => {
    const asset_id = req.params.id

    if (!asset_id) {
      return reply.code(400).send({
        error: '400 Bad Request',
        message: 'No asset ID provided',
      })
    }

    const validPattern = /^[a-zA-Z0-9_-]+$/
    if (!validPattern.test(asset_id)) {
      return reply.code(400).send({
        error: '400 Bad Request',
        message: 'Invalid asset ID',
      })
    }

    // Validate API key
    const keyValidation = await validateKey(req)
    if (!keyValidation.valid) {
      return reply.code(keyValidation.error.status).send({
        error: keyValidation.error.error,
        message: keyValidation.error.message,
        meta: {
          keyData: keyValidation.keyData,
        },
      })
    }

    const { includeUpcoming, keyData } = keyValidation

    // A read that fails is not an asset that is missing. These used to be indistinguishable - the
    // cache layer reported a Firestore error as `exists: false` - so a blip answered 404 for an asset
    // that exists. It throws now, and a 503 tells the caller to retry instead of caching a wrong 404.
    let filesDoc
    let infoDoc
    try {
      filesDoc = await db.collection('files').doc(asset_id).get()
      if (filesDoc.exists) {
        infoDoc = await db.collection('assets').doc(asset_id).get()
      }
    } catch (err) {
      console.error(`[V2 FILES] Firestore read failed for ${asset_id}:`, err)
      reply.header('Cache-Control', 'no-store')
      return reply.code(503).send({
        error: '503 Service Unavailable',
        message: 'Could not look up that asset right now, please retry in a moment',
      })
    }

    if (!filesDoc.exists) {
      return reply.code(404).send({
        error: '404 Not Found',
        message: `No asset with id ${escape(asset_id)}`,
      })
    }

    // Check if the asset is upcoming/early access.
    // The files doc existing does not strictly guarantee the assets doc does, and reading `.staging`
    // off a null would throw a TypeError out of an async handler - which on this Node version can
    // take the whole process down rather than just this request.
    const infoData = infoDoc.data()
    if (!infoData) {
      console.error(`[V2 FILES] ${asset_id} has a files doc but no assets doc`)
      return reply.code(404).send({
        error: '404 Not Found',
        message: `No asset with id ${escape(asset_id)}`,
      })
    }
    if (infoData.staging) {
      return reply.code(403).send({
        error: '403 Forbidden',
        message: 'Asset is in staging',
        meta: {
          includeUpcoming,
          keyData,
        },
      })
    }
    const now = Math.floor(Date.now() / 1000)
    if (!includeUpcoming && infoData.date_published > now) {
      return reply.code(403).send({
        error: '403 Forbidden',
        message: 'Asset is in early access',
        meta: {
          includeUpcoming,
          keyData,
        },
      })
    }

    return reply.code(200).send({
      message: 'OK',
      data: filesDoc.data(),
      meta: {
        includeUpcoming,
        keyData,
      },
    })
  })
}
