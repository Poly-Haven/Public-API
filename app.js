const express = require('express');
const cors = require('cors')
require('dotenv').config()

const app = express();
app.use(cors())

const assetsRoute = require('./routes/assets');
app.use('/assets', assetsRoute);

const infoRoute = require('./routes/info');
app.use('/info', infoRoute);

const rendersRoute = require('./routes/renders');
app.use('/renders', rendersRoute);

const filesRoute = require('./routes/files');
app.use('/files', filesRoute);

const categoriesRoute = require('./routes/categories');
app.use('/categories', categoriesRoute);

const typesRoute = require('./routes/types');
app.use('/types', typesRoute);

const collectionsRoute = require('./routes/collections');
app.use('/collections', collectionsRoute);

const dlTrackRoute = require('./routes/dl_track');
app.use('/dl_track', dlTrackRoute);

const patronsRoute = require('./routes/patrons');
app.use('/patrons', patronsRoute);

const patronsLatestRoute = require('./routes/patrons_latest');
app.use('/patrons_latest', patronsLatestRoute);

const patreonHookRoute = require('./routes/patreon_hook');
app.use('/patreon_hook', patreonHookRoute);

const corporateRoute = require('./routes/corporate');
app.use('/corporate', corporateRoute);

const fundingRoute = require('./routes/funding');
app.use('/funding', fundingRoute);

const financesRoute = require('./routes/finances');
app.use('/finances', financesRoute);

const authorRoute = require('./routes/author');
app.use('/author', authorRoute);

const sponsorRoute = require('./routes/sponsor');
app.use('/sponsor', sponsorRoute);

app.get('/', (req, res) => {
  res.status(400).send(`Welcome to the Poly Haven API!
  Documentation for available endpoints is here:
  https://github.com/Poly-Haven/Public-API`);
})

app.listen(3000);