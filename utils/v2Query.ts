import type { FastifyRequest } from 'fastify'

import { assetTypes } from './schemas.ts'

/**
 * Whether every querystring value is a plain string. The app parses queries with qs, so `?type[]=x` really
 * arrives as an array and `?a[b]=c` as an object; v1 answers those with a 500 where it trips over them. v2
 * rejects them up front with a 400, which is also what keeps the cache key space (the raw URL) from filling
 * with shapes no handler understands.
 */
export const hasPlainQuery = (req: FastifyRequest): boolean =>
  Object.values(req.query as Record<string, unknown>).every((value) => typeof value === 'string')

/**
 * Whether `type` names an asset type. An own-key lookup: the shared helpers behind v1 test `type in asset_types`,
 * which is also true of inherited names, so `?t=constructor` would pass as a type there. v2 checks here first and
 * answers 400; v1 keeps its behaviour. An empty value is no filter at all, as everywhere, so it passes.
 */
export const isAssetType = (type: string | undefined): boolean => !type || Object.hasOwn(assetTypes, type)
