import { buildApp } from './app.ts'

// Fastify answers a rejected route handler itself (the error handler in app.ts), so this no longer covers
// requests. It is the net for stray promises outside handlers - a floating `.then()` or a timer - which on
// Node would otherwise terminate the process by default, taking every other in-flight request on this node
// down with it. PM2 restarts us, but the blast radius is the whole node for one fault.
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION] a promise failed without being caught:', reason)
})

const start = async () => {
  const fastify = await buildApp()

  // Once the replacement is ready, PM2 sends the old worker SIGINT. Stop taking new connections and let
  // in-flight requests finish, but exit before PM2's kill_timeout (5s) would SIGKILL us mid-response.
  process.on('SIGINT', () => {
    fastify.close().finally(() => process.exit(0))
    setTimeout(() => process.exit(0), 4000).unref()
  })

  await fastify.listen({ port: Number(process.env.PORT) || 3000, host: process.env.HOST || '::' })
  // PM2 runs this in cluster mode with wait_ready (see ecosystem.config.cjs): on reload it keeps the old
  // worker serving until the new one sends this, so a deploy never leaves the port unanswered.
  if (process.send) process.send('ready')
}
start().catch((err) => {
  console.error('Failed to start:', err)
  process.exit(1)
})
