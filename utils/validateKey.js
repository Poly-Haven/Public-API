const cachedFirestore = require('./cachedFirestore')
const patreon_tiers = require('../constants/patreon_tiers.json')

const validateKey = async (req) => {
  const db = cachedFirestore()

  // Key must be provided
  const authHeader = req.headers.authorization
  if (!authHeader) {
    return {
      valid: false,
      error: {
        status: 403,
        error: '403 Forbidden',
        message: 'Please provide an API key in the Authorization header',
      },
    }
  }

  // Validate API key format
  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader
  const allowedKeyChars = 'abcdef0123456789'
  if (apiKey.length !== 64 || [...apiKey].some((c) => !allowedKeyChars.includes(c))) {
    return {
      valid: false,
      error: {
        status: 403,
        error: '403 Forbidden',
        message: 'Invalid API key format',
      },
    }
  }

  // Check if key exists in database
  let keyDoc = await db.collection('api_keys').doc(apiKey).get()
  if (!keyDoc.exists) {
    return {
      valid: false,
      error: {
        status: 403,
        error: '403 Forbidden',
        message: 'Invalid API key',
      },
    }
  }

  // Check if key is active
  const keyData = keyDoc.data()
  if (keyData.status !== 'active') {
    return {
      valid: false,
      error: {
        status: 403,
        error: '403 Forbidden',
        message: 'API key is not active',
      },
    }
  }

  let includeUpcoming = false

  // For Superhive customers, we always include early access
  if (keyData.superhive_uid) {
    includeUpcoming = true
  } else {
    if (keyData.patron_uid) {
      const patronDoc = await db.collection('patrons').doc(keyData.patron_uid).get()
      if (patronDoc.exists) {
        const patronData = patronDoc.data()
        let patronIsValid = false
        if (patronData['status'] === 'active_patron') {
          patronIsValid = true
        } else if (patronData['last_charge_status'] === 'Paid') {
          const now = Date.now()
          const lastCharge = Date.parse(patronData['last_charge_date'])
          const daysAgo = (now - lastCharge) / 1000 / 60 / 60 / 24
          if (daysAgo <= 31 || (patronData['yearly_pledge'] && daysAgo <= 365)) {
            patronIsValid = true
          }
        }
        if (patronIsValid && patronData['tiers']) {
          for (const tier of patronData['tiers']) {
            if (Object.keys(patreon_tiers).includes(tier)) {
              for (const r of patreon_tiers[tier].rewards) {
                if (r === 'Early Access') {
                  includeUpcoming = true
                  break
                }
              }
            }
          }
        }
      }
    }
  }

  return {
    valid: true,
    includeUpcoming,
    keyData,
  }
}

module.exports = validateKey
