// Shapes shared by the routes' Fastify generics and the helpers in utils/.
//
// A note on querystrings: the app parses them with qs ('extended', like Express), so a value can really be
// a string, an array or a nested object. The route generics declare the shape the handler's code assumes -
// `string | undefined` - on purpose rather than the honest-but-viral `string | string[] | ParsedQs`: the
// routes' behaviour for a hostile shape (`?categories[]=a`, which throws a TypeError and answers 500) is
// pinned by the parity harness and must not move in a typing exercise. Where a handler genuinely narrows a
// value, it does so at the point of use. The same goes for JSON bodies, which the routes type as the shape
// they expect and then check field by field.

import type { ApiKey } from './firestore.ts'

/** A querystring of plain string values (see the note above). */
export type Query = Record<string, string | undefined>

/** What validateKey() answers. */
export type KeyValidation =
  | { valid: true; includeUpcoming: boolean; keyData: ApiKey }
  | { valid: false; error: { status: number; error: string; message: string }; keyData?: ApiKey }

/** One filter that applyFilters() rejected. */
export interface InvalidAttribute {
  key: string
  value: string
  allowed: string[] | null
  hint: string | null
}
