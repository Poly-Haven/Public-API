const fetch = require('node-fetch')
const { XMLBuilder } = require('fast-xml-parser')

const { thumbnailUrl } = require('../utils/imgUrl')
const { sendText } = require('../utils/http')

const assetTypeNames = ['HDRI', 'Texture', 'Model']

module.exports = async function (fastify) {
  fastify.get('/', async (req, reply) => {
    try {
      // Fetch asset data from the API
      const response = await fetch('https://api.polyhaven.com/assets?t=all')
      const assets = await response.json()

      // Get the timestamp for one month ago
      const oneMonthAgo = Date.now() - 30 * 24 * 60 * 60 * 1000

      // Filter assets to include only those published within the last month
      const recentAssets = Object.keys(assets).filter((id) => assets[id].date_published * 1000 >= oneMonthAgo)

      // Sort assets by most recent publication date
      const sortedAssets = recentAssets.sort((a, b) => assets[b].date_published - assets[a].date_published)

      // Build RSS feed
      const rssFeed = {
        rss: {
          '@_version': '2.0',
          channel: {
            title: 'Poly Haven Assets',
            link: 'https://polyhaven.com',
            description: 'Latest assets from Poly Haven',
            'atom:link': {
              '@_href': `https://api.polyhaven.com/rss`,
              '@_rel': 'self',
              '@_type': 'application/rss+xml',
            },
            item: sortedAssets.map((id) => ({
              title: assets[id].name,
              link: `https://polyhaven.com/a/${id}`,
              guid: id,
              // /assets returns img_version on each asset, so the feed's thumbnails are versioned
              // too - feed readers cache images at least as aggressively as browsers do.
              description: `<![CDATA[<a href="https://polyhaven.com/a/${id}"><img src="${thumbnailUrl(
                id,
                assets[id]
              )}" alt="${assets[id].name}" /></a> Download this free ${
                assetTypeNames[assets[id].type]
              } from Poly Haven]]>`,
              pubDate: new Date(assets[id].date_published * 1000).toUTCString(),
            })),
          },
        },
      }

      // Convert to XML
      const builder = new XMLBuilder({ ignoreAttributes: false })
      const rss = builder.build(rssFeed)

      // Set response headers and send RSS feed
      reply.header('Content-Type', 'application/rss+xml')
      return sendText(reply, 200, rss)
    } catch (error) {
      console.error('Error generating RSS feed:', error)
      return sendText(reply, 500, 'Failed to generate RSS feed')
    }
  })
}
