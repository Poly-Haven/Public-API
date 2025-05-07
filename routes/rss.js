const express = require('express')
const fetch = require('node-fetch')
const { XMLBuilder } = require('fast-xml-parser')
const router = express.Router()

const assetTypeNames = ['HDRI', 'Texture', 'Model']

router.get('/', async (req, res) => {
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
          item: sortedAssets.map((id) => ({
            title: assets[id].name,
            link: `https://polyhaven.com/a/${id}`,
            description: `<![CDATA[<a href="https://polyhaven.com/a/${id}"><img src="https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256" alt="${
              assets[id].name
            }" /></a> Download this free ${assetTypeNames[assets[id].type]} from Poly Haven]]>`,
            pubDate: new Date(assets[id].date_published * 1000).toUTCString(),
          })),
        },
      },
    }

    // Convert to XML
    const builder = new XMLBuilder({ ignoreAttributes: false })
    const rss = builder.build(rssFeed)

    // Set response headers and send RSS feed
    res.set('Content-Type', 'application/rss+xml')
    res.status(200).send(rss)
  } catch (error) {
    console.error('Error generating RSS feed:', error)
    res.status(500).send('Failed to generate RSS feed')
  }
})

module.exports = router
