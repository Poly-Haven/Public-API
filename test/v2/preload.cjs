'use strict'
// Preloaded (node -r) by `npm test`: the parity write guard, with a write log in the temp folder when the caller
// has not chosen one. The guard makes every Firestore write and mutating HTTP call a recorded no-op, which is
// what lets these tests run against production Firestore (reads are real) and still exercise create_key.
const os = require('os')
const path = require('path')

if (!process.env.PARITY_WRITE_LOG) {
  process.env.PARITY_WRITE_LOG = path.join(os.tmpdir(), 'api-v2-test-writes.log')
}
require('../parity/guard.js')
