const express = require('express');
require('dotenv').config()

const app = express();

const assetsRoute = require('./routes/assets');
app.use('/assets', assetsRoute);

const infoRoute = require('./routes/info');
app.use('/info', infoRoute);

const categoriesRoute = require('./routes/categories');
app.use('/categories', categoriesRoute);

const typesRoute = require('./routes/types');
app.use('/types', typesRoute);

const collectionsRoute = require('./routes/collections');
app.use('/collections', collectionsRoute);

app.get('/', (req, res) => {
  res.status(400).send(`Welcome to the Poly Haven API!
  Documentation for available endpoints is here:
  https://github.com/Poly-Haven/Public-API`);
})

app.listen(3000);