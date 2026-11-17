// The entry point PM2 and `npm start` run. Kept as plain JS on purpose: PM2 sniffs the extension of its script
// (a .ts one makes it reach for ts-node) and loads it through its own wrapper. Node runs the TypeScript itself
// (type stripping), so there is no build step; everything real is in server.ts and app.ts.
await import('./server.ts')
