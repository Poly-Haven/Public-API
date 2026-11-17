import { assetTypes as asset_types, attributeSchema as attributes, taxonomy } from './schemas.ts'

// The bodies of /taxonomy and /taxonomy/:type, shared with /v2/taxonomy (which wraps them in `data`).

/** The real asset types, without `all`. */
export const typeNames = Object.keys(asset_types).filter((t) => t !== 'all')

/** { types: {hdris: [...], textures: [...], models: [...]}, attributes: {...} } */
export const taxonomyIndex = () => ({
  types: taxonomy.types,
  attributes: attributes.types,
})

/** { type, categories: [...], attributes: {...} }, or null when `type` is not one of typeNames. */
export const taxonomyOfType = (asset_type: string) => {
  if (!(asset_type in asset_types) || asset_type === 'all') return null
  return {
    type: asset_type,
    categories: taxonomy.types[asset_type],
    attributes: attributes.types[asset_type],
  }
}
