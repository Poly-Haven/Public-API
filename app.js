const express = require('express');
const cors = require('cors')
const fs = require('fs')
const YAML = require('yamljs');
require('dotenv').config()

const app = express();
app.use(cors())

const swaggerDocument = YAML.load('./swagger.yml');
app.get("/api-docs/swagger.json", (req, res) => res.json(swaggerDocument))

const routeDir = "./routes/"
fs.readdir(routeDir, (err, files) => {
  files.forEach(file => {
    fn = file.split('.')[0]
    if (fn === 'tmp' && process.env.NODE_ENV !== 'development') return
    const r = require(routeDir + fn);
    try {
      app.use('/' + fn, r);
    } catch (err) {
      console.log("Failed to register endpoint", fn)
      console.log(err)
    }
  })
});

app.get('/', (req, res) => {
  res.status(200).send(`Welcome to the Poly Haven API!
  Documentation for available endpoints is here:
  https://redocly.github.io/redoc/?url=https://api.polyhaven.com/api-docs/swagger.json&nocors`);
})

app.listen(3000);