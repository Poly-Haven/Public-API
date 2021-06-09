const express = require('express');
const cors = require('cors')
const fs = require('fs')
require('dotenv').config()

const app = express();
app.use(cors())

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
  res.status(400).send(`Welcome to the Poly Haven API!
  Documentation for available endpoints is here:
  https://github.com/Poly-Haven/Public-API`);
})

app.listen(3000);