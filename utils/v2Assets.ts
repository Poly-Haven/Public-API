import type { FastifyReply } from 'fastify'

import type { Asset, FilesDoc } from '../types/firestore.ts'
import cachedFirestore from './cachedFirestore.ts'
import { sendError } from './v2Cache.ts'

const db = cachedFirestore()

const MAX_ID_LENGTH = 50
const VALID_ID = /^[a-zA-Z0-9_-]+$/

/** The shared 400 for an asset id that cannot be a slug (cacheable: the same id will always be bad). */
export const checkAssetId = (reply: FastifyReply, id: string | undefined) => {
  if (!id) return sendError(reply, 400, 'No asset ID provided')
  if (id.length > MAX_ID_LENGTH || !VALID_ID.test(id)) return sendError(reply, 400, 'Invalid asset ID')
  return null
}

/** Epoch seconds. */
export const nowSeconds = () => Math.floor(Date.now() / 1000)

/** Early access: published in the future (vault assets are dated year 3000). */
export const isEarlyAccess = (asset: Pick<Asset, 'date_published'>, now = nowSeconds()) => asset.date_published > now

export type FilesLookup = { found: false } | { found: true; files: FilesDoc; asset: Asset; earlyAccess: boolean }

/**
 * The files doc and the asset doc of a non-staging asset, read through the collection cache. `found: false`
 * covers an unknown id, an asset with no files doc or no asset doc, and a staging asset, which must be
 * indistinguishable from an unknown one. Throws when Firestore cannot be read: a failed read is not a missing
 * asset (callers answer 503).
 */
export const lookupFiles = async (id: string): Promise<FilesLookup> => {
  const filesDoc = await db.collection<FilesDoc>('files').doc(id).get()
  if (!filesDoc.exists) return { found: false }
  // The files doc existing does not guarantee the assets doc does.
  const asset = (await db.collection<Asset>('assets').doc(id).get()).data()
  if (!asset || asset.staging) return { found: false }
  return { found: true, files: filesDoc.data() as FilesDoc, asset, earlyAccess: isEarlyAccess(asset) }
}
