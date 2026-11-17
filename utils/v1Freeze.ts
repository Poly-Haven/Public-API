import allowlistJson from '../constants/v1_ea_allowlist.json' with { type: 'json' }
import type { Asset } from '../types/firestore.ts'

// The v1 early-access freeze.
//
// v1's `future=true` is unauthenticated: anyone can list early-access assets and fetch their files. v2 keeps the
// metadata public but puts the files behind a key. Legacy add-on users and third parties on v1 were promised
// the early-access content that existed up to the freeze, so at the freeze (switched on at year end) the
// allowlist file is filled with the slugs that exist then, and from that moment v1 hides every early-access
// asset that is not on it. Assets released afterwards (their date_published passes) leave early access and
// show up in v1 normally. While the file holds `null`, nothing here does anything.

export interface V1Allowlist {
  frozen_at: string
  slugs: string[]
}

const fromFile = allowlistJson as V1Allowlist | null

let allowlist: V1Allowlist | null = fromFile
let slugSet: Set<string> | null = fromFile && new Set(fromFile.slugs)

/** Whether the freeze is switched on (the allowlist file is not null). */
export const v1FreezeActive = () => allowlist !== null

/**
 * True when the freeze is on, the asset is early access (`date_published` in the future, epoch seconds) and its
 * slug is not on the allowlist: v1 must then behave as though the asset does not exist.
 */
export const isHiddenFromV1 = (slug: string, asset: Pick<Asset, 'date_published'>, now: number): boolean =>
  slugSet !== null && asset.date_published > now && !slugSet.has(slug)

/** For tests: replace the allowlist in-process. `undefined` restores what the file says. */
export const setV1Allowlist = (value?: V1Allowlist | null) => {
  allowlist = value === undefined ? fromFile : value
  slugSet = allowlist && new Set(allowlist.slugs)
}
