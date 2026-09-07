const cachedFirestore = require('./cachedFirestore')
const patreon_tiers = require('../constants/patreon_tiers.json')

/**
 * Returned when a Firestore read fails, as opposed to succeeding and finding nothing.
 *
 * The distinction matters more than it looks. A read error used to surface as `exists: false`, so a
 * momentary Firestore blip told a paying Superhive or Patreon customer their key was invalid - a 403,
 * which reads as permanent and which a client may respond to by discarding the key. 503 says what is
 * actually true: we could not check, try again.
 */
const unavailable = (what) => ({
  valid: false,
  error: {
    status: 503,
    error: '503 Service Unavailable',
    message: `Could not verify ${what} right now, please retry in a moment`,
  },
})

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
  let keyDoc
  try {
    keyDoc = await db.collection('api_keys').doc(apiKey).get()
  } catch (err) {
    console.error('[VALIDATE KEY] Could not read api_keys:', err)
    return unavailable('your API key')
  }
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
      keyData,
    }
  }

  let includeUpcoming = false

  // For Superhive customers, we always include early access
  if (keyData.superhive_uid) {
    includeUpcoming = true
  } else {
    if (keyData.patron_uid) {
      // Also 503 rather than quietly leaving includeUpcoming false. Failing to confirm a patron's
      // tier is not the same as confirming they have no early access, and the second is what the
      // old behaviour asserted - so a supporter with the Early Access reward would hit a 403 on the
      // very assets they pay for. A retryable error is the honest answer to a read we could not do.
      let patronDoc
      try {
        patronDoc = await db.collection('patrons').doc(keyData.patron_uid).get()
      } catch (err) {
        console.error('[VALIDATE KEY] Could not read patrons:', err)
        return unavailable('your supporter status')
      }
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
