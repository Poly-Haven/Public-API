import { buildApp } from './app.ts'
import firestore from './firestore.ts'

// Fastify answers a rejected route handler itself (the error handler in app.ts), so this no longer covers
// requests. It is the net for stray promises outside handlers - a floating `.then()` or a timer - which on
// Node would otherwise terminate the process by default, taking every other in-flight request on this node
// down with it. PM2 restarts us, but the blast radius is the whole node for one fault.
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION] a promise failed without being caught:', reason)
})

// Secrets the app cannot run safely without. A missing one is not a harmless gap: with DL_KEY unset, the
// endpoints guarded by it (dl_track, gallery_click, track_search) accept unauthenticated writes, and with
// SUPERHIVE_KEY unset the webhook is mounted at the guessable path /v2/superhive_undefined. So the process
// refuses to start (PM2 then keeps the old worker on a reload) instead of serving in that state.
const REQUIRED_SECRETS = ['DL_KEY', 'PATRON_INFO_KEY', 'PATREON_HOOK_SECRET', 'SUPERHIVE_KEY', 'API_KEY_MASTER']

const start = async () => {
  const missing = REQUIRED_SECRETS.filter((name) => !process.env[name])
  if (missing.length) {
    // Names only, never values.
    console.error(`Refusing to start: required environment variable(s) unset or empty: ${missing.join(', ')}`)
    process.exit(1)
  }

  const fastify = await buildApp()

  // Prove Firestore works before saying we are ready. Without this, a node with a bad credential or no route to
  // Google would start, tell PM2 it is ready, and PM2 would retire the healthy old worker for it; failing here
  // makes the reload keep the old worker.
  await firestore().collection('assets').limit(1).get()

  // Once the replacement is ready, PM2 sends the old worker SIGINT (a plain `pm2 stop` or a systemd stop sends
  // SIGTERM). Stop taking new connections and let in-flight requests finish, but exit before PM2's kill_timeout
  // (5s) would SIGKILL us mid-response.
  const shutdown = () => {
    fastify.close().finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 4000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await fastify.listen({ port: Number(process.env.PORT) || 3000, host: process.env.HOST || '::' })
  // PM2 runs this in cluster mode with wait_ready (see ecosystem.config.cjs): on reload it keeps the old
  // worker serving until the new one sends this, so a deploy never leaves the port unanswered.
  if (process.send) process.send('ready')
}
start().catch((err) => {
  console.error('Failed to start:', err)
  process.exit(1)
})
