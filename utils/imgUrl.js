// Bunny serves every image on cdn.polyhaven.com with a ~1 year max-age, so a replaced image cannot
// be corrected by a purge - not Bunny's, not Cloudflare's, and least of all in a browser that
// already holds a copy. The only thing that reliably busts it is a different URL, so asset image
// URLs carry a `v` param derived from the images' own content (assets/{slug}.img_version, written
// by admin's compile pipeline).
//
// Bunny keys its cache on unknown query params and its Optimizer ignores them, so `v` sits happily
// alongside width/height/quality without disturbing the resizing. `v` is deliberately not one of
// the Optimizer's own params (width, height, quality, format, aspect_ratio, crop_gravity, blur,
// sharpen, ...) so it is passed through untouched.

const CDN = 'https://cdn.polyhaven.com'
const VERSION_PARAM = 'v'

// Values are emitted verbatim rather than percent-encoded, so the output stays byte-identical to
// the URLs these routes have always produced. Every param used here is numeric; anything needing
// encoding does not belong in this helper.
const buildQuery = (params) => {
  const parts = []
  for (const key in params) {
    const value = params[key]
    if (value === undefined || value === null || value === '') continue
    parts.push(`${key}=${value}`)
  }
  return parts.join('&')
}

// `version` is optional throughout: an asset compiled before img_version existed simply gets the
// unversioned URL it got before, which is exactly the old behaviour rather than a broken one.
const cdnUrl = (path, params, version) => {
  const query = Object.assign({}, params)
  if (version) {
    query[VERSION_PARAM] = version
  }
  const qs = buildQuery(query)
  return `${CDN}/${path}${qs ? '?' + qs : ''}`
}

// The one shape three routes (/info, /assets, /v2/assets) and the RSS feed all need. Takes the
// whole asset document so callers cannot forget the version.
const thumbnailUrl = (slug, asset) =>
  cdnUrl(`asset_img/thumbs/${slug}.png`, { width: 256, height: 256 }, asset && asset.img_version)

module.exports = { CDN, VERSION_PARAM, cdnUrl, thumbnailUrl }
