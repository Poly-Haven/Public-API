import cachedFirestore from '../../utils/cachedFirestore.ts'
import validateKey from '../../utils/validateKey.ts'
const db = cachedFirestore()

export default async function (fastify) {
  fastify.get('/', async (req, reply) => {
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

    const returnData = {
      version: 'v1',
      blocklist: [],
      data: [],
    }

    let collectionRef = db.collection('extension')

    const collection = await collectionRef.get()
    const compatibleVersions = {}
    collection.forEach((doc) => {
      const ext = doc.data()
      // if (ext.version === '2.0.0') return // DEBUG
      const isCompatible =
        !req.query.blender_version ||
        ext.blender_version_min.localeCompare(req.query.blender_version, undefined, {
          numeric: true,
          sensitivity: 'base',
        }) <= 0

      if (isCompatible) {
        compatibleVersions[doc.id] = ext
      }
    })

    // If blender_version is provided, return only the highest compatible version
    if (req.query.blender_version) {
      const highestVersion = Object.keys(compatibleVersions).sort((a, b) => {
        return compatibleVersions[b].version.localeCompare(compatibleVersions[a].version, undefined, {
          numeric: true,
          sensitivity: 'base',
        })
      })[0]
      if (highestVersion) {
        returnData.data.push(compatibleVersions[highestVersion])
      }
    } else {
      // Otherwise, return all versions
      for (const id in compatibleVersions) {
        returnData.data.push(compatibleVersions[id])
      }
    }

    return reply.code(200).send({
      ...returnData,
      message: 'OK',
      meta: {
        includeUpcoming,
        keyData,
      },
    })
  })
}
