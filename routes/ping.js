import { execSync } from 'node:child_process'

const revision = execSync('git rev-list --format=oneline --max-count=1 HEAD').toString().trim()

import * as embeddingIndex from '../utils/embeddingIndex.ts'
import * as keywordIndex from '../utils/keywordIndex.ts'
import * as workersAI from '../utils/workersAI.ts'

export default async function (fastify) {
  fastify.get('/', async (req, reply) => {
    return reply.code(200).send({
      time: Date.now(),
      node: process.env.NODE_ID || 'UNKNOWN',
      commit: revision,
      // The nodes are not necessarily on the same runtime build. Reporting it here means the next person to
      // wonder can curl instead of hunting for ssh credentials.
      runtime: process.version,
      // The search index is per-node and built lazily, and admin's /clear_cache fan-out is what keeps
      // it current. Surfacing it here means a node with a stale or failed index is visible without SSH.
      search: {
        index: embeddingIndex.stats(),
        keyword: keywordIndex.stats(),
        queryCache: workersAI.stats(),
      },
    })
  })
}
