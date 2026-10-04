// PM2 config for the api nodes. `deploy.sh` reloads from this file, so changes here reach the nodes on the
// next deploy - except exec_mode, which PM2 only applies on a fresh `pm2 start` after `pm2 delete app`.
//
// Cluster mode is what makes `pm2 reload` zero-downtime: it starts the new worker, waits for app.js to
// send 'ready' once it is listening, and only then stops the old one. In fork mode a reload is a plain
// restart and the port is closed until the new process comes up.
//
// One instance, not one per core: the boxes have a single CPU, and each worker keeps its own in-memory
// Firestore cache and search index, so a second worker would roughly double origin Firestore reads and
// admin's /clear_cache fan-out would only reach whichever worker answered it.
module.exports = {
  apps: [
    {
      name: 'app',
      script: 'app.js',
      cwd: __dirname, // dotenv reads .env from the cwd
      exec_mode: 'cluster',
      instances: 1,
      wait_ready: true,
      listen_timeout: 30000, // give up waiting for 'ready' after this long
      kill_timeout: 5000, // app.js exits within 4s of SIGINT
      time: true,
      merge_logs: true, // keep app-out.log / app-error.log rather than per-worker files
    },
  ],
}
