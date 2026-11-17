// Shapes of the Firestore documents this API reads and writes. Derived from how the routes use them, not
// from a schema: admin.polyhaven.com writes most of these, so a field is optional here whenever some code
// path guards for its absence. Documents that are genuinely open-ended (the nested file tree of `files`,
// `search_stats`) keep an index signature; the rest do not, so a typo on a field name is a type error.
//
// Casts to these types happen once, where `doc.data()` leaves Firestore (`doc.data() as Asset`).

/** Index into asset_types.json: 0 = hdris, 1 = textures, 2 = models. */
export type AssetTypeIndex = 0 | 1 | 2

/** assets/{slug} */
export interface Asset {
  name: string
  type: AssetTypeIndex
  /** Epoch seconds. Future = early access; a vaulted asset is parked on a year-3000 date. */
  date_published: number
  /** Legacy multi-value categories, still carrying the "vault: <id>" / "collection: <id>" strings. */
  categories: string[]
  tags: string[]
  /** Author id -> their credit on this asset. Only the keys are read here. */
  authors: Record<string, unknown>
  /** Single-path category (canonical path), the replacement for `categories`. */
  category?: string
  collections?: string[]
  vault?: string
  /** Per-type attribute values (attributes.json). Scalars, booleans or arrays depending on the attribute. */
  attributes?: Record<string, unknown>
  staging?: boolean
  /** Short content hash of the asset's images, appended to image URLs as `?v=`. */
  img_version?: string
  download_count?: number
  sponsors?: string[]
  prepaid?: boolean
  donated?: boolean
  backplates?: boolean
  /** Internal fields /assets and /v2/assets strip from public responses. */
  old_id?: unknown
  reviewers?: unknown
  scale?: unknown
  /** Added by the API at response time, never stored. */
  thumbnail_url?: string
}

/** files/{slug}: the file tree (type -> resolution -> format -> {url, size, md5, ...}), served as is. */
export interface FilesDoc {
  [key: string]: unknown
}

/** extra_renders/{slug}, authors/{id}, text/{id}, timelines/{id}, courses/{id}, community_prizes/*: served as is. */
export interface OpenDoc {
  [key: string]: unknown
}

export interface Author extends OpenDoc {
  /** Added by /authors: how many assets they appear on. */
  assetCount?: number
}

/** api_keys/{key}. The document id is the 64-hex-character key itself. */
export interface ApiKey {
  status: string
  created_at?: string
  /** Short random id for lookup and debugging, safe to log (unlike the key). */
  ref?: string
  superhive_uid?: string | number
  patron_uid?: string
}

/** patrons/{patreon user id} */
export interface Patron {
  uid: string
  name: string
  display_name?: string
  /** ISO timestamp of the pledge start. */
  joined: string
  cents: number
  yearly_pledge: boolean
  rank: number
  lifetime_cents: number
  last_charge_date?: string
  last_charge_status?: string
  next_charge_date?: string
  status: string
  last_edited: string
  last_hook?: string
  /** Patreon tier ids (keys of constants/patreon_tiers.json). */
  tiers?: string[]
  anon?: boolean
  url?: string
  auto_sponsor?: boolean
  notify_email?: boolean
  invite_sent?: boolean
  /** "YYYY-M" -> whether this month's Sponsor token has been spent. */
  sponsor_tokens?: Record<string, boolean>
}

/** corporate_sponsors/{id} */
export interface CorporateSponsor {
  name?: string
  rank: number
  usd?: number
  link?: string
  url?: string
  logo?: string
}

/** gallery/{id}: a user-submitted render. Staff-only fields are stripped by routes/gallery.js. */
export interface GalleryRender {
  approval_pending?: boolean
  clicks: number
  /** Epoch ms, set at approval. */
  date_added: number
  favourite?: boolean
  assets_used?: string[]
  /** Free text on older submissions, an array on newer ones. */
  software?: string | string[]
  author_email?: string
  hash?: string
  reviewed_by?: string
  ai_use?: unknown
  ai_note?: string
  ai_use_submitted?: unknown
  ai_note_submitted?: string
  [key: string]: unknown
}

/** downloads_daily/{day}_{type}_{slug}, written by admin. */
export interface DownloadDaily {
  day: string
  type: 'ALL' | 'TYPE' | 'TYPE_FORMAT' | 'TYPE_RES' | 'ASSET'
  slug: string
  downloads: number
  unique: number
}

/** downloads_daily_cf/{day}: Cloudflare's view, only the fields /stats/cfdownloads projects. */
export interface DownloadsDailyCf {
  by_type?: Record<string, { downloads: number }>
  classes?: Record<string, { downloads: number }>
}

/** finances/{YYYY-MM} */
export interface FinanceMonth {
  expense: Record<string, number>
  rates: Record<string, number>
  [key: string]: unknown
}

/** milestones/{id} */
export interface Milestone {
  target: number
  achieved?: boolean
  [key: string]: unknown
}

/** vaults/{id}. `status` is missing on documents written before the field existed (counts as upcoming). */
export interface Vault {
  status?: 'upcoming' | 'locked' | 'unlocked'
  milestone_id?: string
  [key: string]: unknown
}

/** news/{id} and news_blender/{id}. Dates are ISO strings, compared as text. */
export interface NewsItem {
  active: boolean
  date_start: string
  date_end: string
  [key: string]: unknown
}

/** extension/{id}: one version of the paid Blender add-on. */
export interface ExtensionDoc {
  version: string
  blender_version_min: string
  [key: string]: unknown
}

/** patron_counts/{YYYY-MM}: day of month -> tier -> active patrons. */
export type PatronCountsDoc = Record<string, Record<string, number>>

/** cloudflare_analytics/{day}: site -> GraphQL response, only the fields /stats/cfdaily trims. */
export interface CloudflareAnalyticsDoc {
  [site: string]: {
    data?: {
      viewer: {
        zones: {
          httpRequests1dGroups: {
            sum: { countryMap?: unknown; responseStatusMap?: unknown; ipClassMap?: unknown }
          }[]
        }[]
      }
    }
  }
}

/** asset_embeddings/{slug}: an int8-quantised vector. `v` is a Firestore Blob, read as a Buffer. */
export interface AssetEmbedding {
  v?: Buffer
  model?: string
}

/** What /v2/create_key writes to api_keys/{key}. */
export type NewApiKey = Pick<ApiKey, 'status' | 'created_at' | 'patron_uid' | 'superhive_uid' | 'ref'>

/** log/{timestamp+rand}: audit trail rows the API writes. */
export type LogEntry =
  | { type: 'granttoken'; timestamp: string; uuid: string }
  | { type: 'sponsor'; timestamp: string; uuid: string; assetID: string }

/** The body of a Patreon members:pledge:* webhook, as far as /patreon_hook reads it. */
export interface PatreonHookPayload {
  data: {
    attributes: {
      full_name?: string
      pledge_relationship_start: string
      currently_entitled_amount_cents: number
      pledge_cadence: number
      lifetime_support_cents: number
      last_charge_date?: string
      last_charge_status?: string
      next_charge_date?: string
      patron_status: string
    }
    relationships: {
      user: { data: { id: string } }
      currently_entitled_tiers: { data: { id: string }[] }
    }
  }
  /** Added by the API from the X-Patreon-Event header. */
  hook?: string
  /** Added by the API. */
  timestamp?: string
}

/** constants/patreon_tiers.json */
export type PatreonTiers = Record<string, { comment: string; name: string; rewards: string[] }>
