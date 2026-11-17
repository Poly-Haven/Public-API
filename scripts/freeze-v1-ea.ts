// Fills in constants/v1_ea_allowlist.json for the v1 early-access freeze (see utils/v1Freeze.ts): every
// non-staging asset whose date_published is in the future, as of now.
//
//   node scripts/freeze-v1-ea.ts --dry-run    print what would be written, write nothing
//   node scripts/freeze-v1-ea.ts              write the file
//
// Read-only against Firestore (one read of the assets collection). To be safe on a machine that has the
// production credentials, preload the write guard: node -r ./test/v2/preload.cjs scripts/freeze-v1-ea.ts --dry-run
import fs from 'node:fs'
import path from 'node:path'

import firestore from '../firestore.ts'
import type { Asset } from '../types/firestore.ts'
import type { V1Allowlist } from '../utils/v1Freeze.ts'

const dryRun = process.argv.includes('--dry-run')
const target = path.join(import.meta.dirname, '..', 'constants', 'v1_ea_allowlist.json')

const now = Math.floor(Date.now() / 1000)
const slugs: string[] = []
const snapshot = await firestore().collection('assets').get()
snapshot.forEach((doc) => {
  const asset = doc.data() as Asset
  if (!asset.staging && asset.date_published > now) slugs.push(doc.id)
})
slugs.sort()

const allowlist: V1Allowlist = { frozen_at: new Date(now * 1000).toISOString(), slugs }
const json = JSON.stringify(allowlist, null, 2) + '\n'

if (dryRun) {
  console.log(`[dry run] ${slugs.length} early-access assets would be allowlisted, frozen_at ${allowlist.frozen_at}`)
  console.log(`[dry run] ${target} not written`)
} else {
  fs.writeFileSync(target, json)
  console.log(`Wrote ${slugs.length} early-access slugs to ${target}`)
}
