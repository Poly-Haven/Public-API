import { existsSync } from 'node:fs'

// Loads .env from the working directory when there is one (local dev, and the nodes, where PM2 runs from the
// repo root). Variables already set in the environment win over the file, as they did with dotenv. Imported
// for its side effect by every module that reads configuration at load time.
if (existsSync('.env')) process.loadEnvFile('.env')
